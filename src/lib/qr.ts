// Renamed on import: the package's default export is also called `qrcode`,
// and the linter rightly flags a default import wearing a named export's
// name as something a reader will misread.
import makeQrCode from 'qrcode-generator';

// The QR printed on a receipt, and the short code printed under it.
//
// The two are NOT interchangeable, and the difference matters:
//
//   - The QR carries the whole sale id. It is the authoritative value -- scan
//     it and you have resolved exactly one sale, forever.
//   - The short code is eight characters of that same id, for a human to read
//     down the phone or type into search. It can collide, and that is fine:
//     it only narrows a list for someone to pick from. It must never be used
//     as a lookup key on its own.
//
// Nothing here is derived from the render moment -- only from `sale.id`, which
// is frozen at the till. A reprint of last Tuesday's sale therefore produces a
// byte-identical code, which is the whole point of encoding the id rather than
// anything computed. (See `formatTodayHours` in receipt.ts for the bug that
// taught us to care: a receipt that prints something different the second time
// is worse than one that omits it.)

// Distinguishes a receipt scan from a product barcode. Product codes are EANs,
// UPCs and shop-typed SKUs; none of them start with this, so a scanner handler
// can route on the prefix without guessing at overlapping namespaces.
export const RECEIPT_CODE_PREFIX = 'KR-';

// Uppercase hex with a hyphen keeps the payload inside QR's *alphanumeric*
// charset (0-9 A-Z space and $%*+-./:), which encodes at 5.5 bits per
// character. Lowercase would fall out of that set and force byte mode at 8
// bits, pushing a 35-character payload from a 25x25 symbol to a 29x29 one --
// about 35% more area on tape that is only 80mm wide. The `toUpperCase()`
// below is load-bearing, not cosmetic.
export function receiptPayload(saleId: string): string {
  return `${RECEIPT_CODE_PREFIX}${saleId.replace(/-/g, '').toUpperCase()}`;
}

// Eight characters, hyphenated in the middle so the eye can hold it: 4F2A-0193.
// Short ids that cannot fill both halves are returned as-is rather than padded
// with filler a caller might later mistake for part of the id.
export function receiptShortCode(saleId: string): string {
  const hex = saleId.replace(/-/g, '').toUpperCase();
  if (hex.length < 8) return hex;
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

// `0` asks the library for the smallest symbol the payload fits in, rather
// than pinning version 2 -- a uuid always lands on 2, but pinning would throw
// on any caller that one day passes something longer, and a receipt that fails
// to render is worse than one with a slightly larger code on it.
//
// ECC level M recovers roughly 15% damage. Thermal paper creases, fades and
// lives in pockets, so the redundancy is doing real work here; L would print a
// marginally smaller symbol that stops scanning sooner.
export function qrModules(payload: string): boolean[][] {
  const qr = makeQrCode(0, 'M');
  qr.addData(payload, 'Alphanumeric');
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qr.isDark(row, col))
  );
}

// The spec's minimum quiet zone. Without it scanners cannot find the symbol's
// edges, and a QR butted against neighbouring ink is a QR that does not read.
export const QR_QUIET_ZONE = 4;

// One `<path>` covering every dark module, rather than a rect per module: a
// version-2 symbol has ~300 dark modules, and 300 elements is a page a printer
// has to think about. As one path it is a single fill.
export function qrPathData(modules: boolean[][], quietZone = QR_QUIET_ZONE): string {
  const parts: string[] = [];
  for (let row = 0; row < modules.length; row++) {
    for (let col = 0; col < modules[row].length; col++) {
      if (modules[row][col]) parts.push(`M${col + quietZone} ${row + quietZone}h1v1h-1z`);
    }
  }
  return parts.join('');
}

export function qrViewBox(modules: boolean[][], quietZone = QR_QUIET_ZONE): string {
  const size = modules.length + quietZone * 2;
  return `0 0 ${size} ${size}`;
}

// Self-contained SVG markup for the printed/PDF receipt, which is built as an
// HTML string rather than components.
//
// `shape-rendering: crispEdges` matters more than it looks: without it the
// renderer antialiases every module edge, and a QR with grey fringes is one a
// scanner has to work harder to threshold -- on a 203dpi thermal head, where a
// module is only three or four dots wide, that is the difference between a
// clean read and a retry.
export function qrSvg(payload: string, sizePx: number): string {
  const modules = qrModules(payload);
  return (
    `<svg viewBox="${qrViewBox(modules)}" width="${sizePx}" height="${sizePx}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="Receipt code">` +
    `<path fill="#111111" d="${qrPathData(modules)}"/></svg>`
  );
}
