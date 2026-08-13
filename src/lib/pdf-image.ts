// A minimal, dependency-free PDF writer for exactly one use: a single-page
// PDF whose entire content is one full-bleed JPEG. That is the whole of what
// poster-export.ts needs on web (see its `downloadPosterPdf`) -- there is no
// PDF library available there without adding a dependency, and a JPEG-in-a-
// page is small and well-specified enough to hand-assemble correctly:
// DCTDecode embeds a JPEG's own compressed bytes verbatim (no re-encoding),
// unlike a PNG, which would need Flate plus predictors to embed cheaply.
//
// Kept pure (bytes in, bytes out, no DOM, no fetch) so it is unit-testable
// without a browser or a renderer -- see `__tests__/pdf-image.test.ts`, which
// checks the one thing actually worth checking: that every offset the xref
// table claims for an object really is where that object starts.

// Reads the pixel dimensions straight out of the JPEG's own SOF segment
// (the same header a real decoder reads them from), rather than requiring a
// caller to pass them in. A PDF image XObject's /Width and /Height are
// required keys distinct from the JPEG's own encoded size, but they must
// agree with it for a correct render -- reading them from the same bytes we
// embed is what guarantees that, rather than trusting a caller to pass a
// number that matches what they captured.
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Not a JPEG (missing SOI marker).');
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // Markers with no length/payload of their own -- skip past just the
    // marker itself rather than reading a segment length that isn't there.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    // SOF0..SOF15 except the four that are actually something else
    // (DHT/JPG/DAC/DHP share the C4/C8/CC/CC-adjacent codes) -- any of the
    // real ones encodes height/width in the same layout.
    const isSofMarker = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSofMarker) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return { width, height };
    }
    if (marker === 0xda) break; // Start of scan -- the header is over.
    offset += 2 + segmentLength;
  }
  throw new Error('Could not find a JPEG SOF marker to read image dimensions.');
}

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// Builds a single-page PDF containing exactly one image: `jpegBytes` drawn
// edge to edge on a page sized `pageWidthPt` x `pageHeightPt` (PDF points,
// 1/72"). Five objects, deliberately no more: catalog -> pages -> page ->
// image XObject -> content stream. Object numbers are assigned in that fixed
// order (1..5) so every offset below can be computed as this function
// serialises rather than estimated up front -- an estimated offset is
// exactly the kind of bug that produces a PDF a permissive viewer opens fine
// and a strict one rejects outright.
export function singleImagePdf(jpegBytes: Uint8Array, pageWidthPt: number, pageHeightPt: number): Uint8Array {
  const { width: imgWidth, height: imgHeight } = jpegDimensions(jpegBytes);

  // `cm` scales the default 1x1-unit square that `Do` paints an image into
  // up to the full page and leaves it positioned at the origin -- edge to
  // edge, no margin, matching posterPageHtml's `@page { margin: 0 }` on the
  // native/print path so the web download and a printed sheet agree on
  // what "the poster" fills.
  const contentStreamBytes = textBytes(`q\n${pageWidthPt} 0 0 ${pageHeightPt} 0 0 cm\n/Im0 Do\nQ`);

  const chunks: Uint8Array[] = [];
  const objectOffsets: number[] = [];
  let cursor = 0;

  const emit = (bytes: Uint8Array) => {
    chunks.push(bytes);
    cursor += bytes.length;
  };

  emit(textBytes('%PDF-1.4\n'));

  const object = (objectNumber: number, body: (string | Uint8Array)[]) => {
    objectOffsets[objectNumber - 1] = cursor;
    emit(textBytes(`${objectNumber} 0 obj\n`));
    for (const part of body) {
      emit(typeof part === 'string' ? textBytes(part) : part);
    }
    emit(textBytes('\nendobj\n'));
  };

  object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  object(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
  object(3, [
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidthPt} ${pageHeightPt}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  ]);
  object(4, [
    `<< /Type /XObject /Subtype /Image /Width ${imgWidth} /Height ${imgHeight} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`,
    jpegBytes,
    '\nendstream',
  ]);
  object(5, [`<< /Length ${contentStreamBytes.length} >>\nstream\n`, contentStreamBytes, '\nendstream']);

  // Object 0 is the head of the free list, per spec, and is never one of
  // ours -- the five real objects start numbering at 1.
  const objectCount = objectOffsets.length + 1;
  const xrefOffset = cursor;
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (const offset of objectOffsets) {
    // Each entry MUST be exactly 20 bytes (10-digit offset, space, 5-digit
    // generation, space, 'n', space, EOL) -- a short line shifts every
    // fixed-width read after it in a strict parser.
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  emit(textBytes(xref));

  emit(textBytes(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`));

  return concatBytes(chunks);
}
