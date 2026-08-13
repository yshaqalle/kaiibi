import { singleImagePdf } from '@/lib/pdf-image';

// A synthetic JPEG -- not a decodable image, but a real enough byte layout
// (SOI, then an SOF0 segment encoding 200x100, then EOI) for
// `singleImagePdf` to read dimensions out of and to embed verbatim. It
// doesn't need scan data: `singleImagePdf` only reads the SOF segment, and
// DCTDecode embedding never inspects the bytes at all, just copies them.
const FAKE_JPEG = new Uint8Array([
  0xff, 0xd8, // SOI
  0xff, 0xc0, // SOF0
  0x00, 0x11, // segment length = 17
  0x08, // precision
  0x00, 0x64, // height = 100
  0x00, 0xc8, // width = 200
  0x03, // 3 components
  0x01, 0x22, 0x00,
  0x02, 0x11, 0x01,
  0x03, 0x11, 0x01,
  0xff, 0xd9, // EOI
]);

function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

describe('singleImagePdf', () => {
  it('starts with the PDF header and ends with the EOF marker', () => {
    const pdf = singleImagePdf(FAKE_JPEG, 595, 842);
    const text = bytesToLatin1(pdf);
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.endsWith('%%EOF')).toBe(true);
  });

  it('embeds the image as a DCTDecode XObject', () => {
    const pdf = singleImagePdf(FAKE_JPEG, 595, 842);
    const text = bytesToLatin1(pdf);
    expect(text).toContain('/DCTDecode');
    expect(text).toContain('/Subtype /Image');
  });

  it('sets the MediaBox to the page size the caller asked for', () => {
    const width = 595;
    const height = 842;
    const pdf = singleImagePdf(FAKE_JPEG, width, height);
    const text = bytesToLatin1(pdf);
    expect(text).toContain(`/MediaBox [0 0 ${width} ${height}]`);
  });

  it('supports a non-A4 page size too (e.g. a square/story shape)', () => {
    const width = 595;
    const height = 595;
    const pdf = singleImagePdf(FAKE_JPEG, width, height);
    const text = bytesToLatin1(pdf);
    expect(text).toContain(`/MediaBox [0 0 ${width} ${height}]`);
  });

  it('embeds the JPEG bytes verbatim, not re-encoded', () => {
    const pdf = singleImagePdf(FAKE_JPEG, 595, 842);
    expect(indexOfBytes(pdf, FAKE_JPEG)).toBeGreaterThanOrEqual(0);
  });

  it('reads the image dimensions from the JPEG itself', () => {
    const pdf = singleImagePdf(FAKE_JPEG, 595, 842);
    const text = bytesToLatin1(pdf);
    expect(text).toContain('/Width 200');
    expect(text).toContain('/Height 100');
  });

  // The assertion that actually catches a broken PDF: a strict reader walks
  // the xref table and jumps straight to each byte offset expecting to land
  // on "N 0 obj". An off-by-one or an estimated-rather-than-measured offset
  // here is invisible in a lenient viewer (which just rescans the whole
  // file for "obj") and fatal in a strict one.
  it('has an xref table whose offsets each point at the start of the object they claim', () => {
    const pdf = singleImagePdf(FAKE_JPEG, 595, 842);
    const text = bytesToLatin1(pdf);

    const xrefKeyword = 'xref\n';
    const xrefAt = text.indexOf(xrefKeyword);
    expect(xrefAt).toBeGreaterThanOrEqual(0);

    const trailerAt = text.indexOf('trailer', xrefAt);
    expect(trailerAt).toBeGreaterThan(xrefAt);

    const xrefBody = text.slice(xrefAt + xrefKeyword.length, trailerAt);
    const lines = xrefBody.split('\n').filter((l) => l.length > 0);

    // First line is "0 <count>"; the rest are fixed-width 20-byte entries,
    // starting with the free-list head (object 0, always "f") then one
    // "n" entry per real object in ascending object-number order.
    const [, countStr] = lines[0].split(' ');
    const count = Number(countStr);
    expect(count).toBe(6); // objects 0..5

    const entries = lines.slice(1);
    expect(entries).toHaveLength(count);

    // Object 0 (the free-list head) has no "obj" to point at -- only the
    // real objects, numbered 1 through count-1, get checked against the
    // file.
    for (let objectNumber = 1; objectNumber < count; objectNumber++) {
      const entry = entries[objectNumber];
      const match = entry.match(/^(\d{10}) (\d{5}) n\s?$/);
      expect(match).not.toBeNull();
      const offset = Number(match![1]);
      const expectedStart = `${objectNumber} 0 obj`;
      expect(text.slice(offset, offset + expectedStart.length)).toBe(expectedStart);
    }
  });

  it('throws on bytes that are not a JPEG', () => {
    expect(() => singleImagePdf(new Uint8Array([0, 1, 2, 3]), 595, 842)).toThrow();
  });
});
