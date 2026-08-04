import type { CartLine, Product } from '@/types/models';

// The retail-relevant subset of expo-camera's barcode types. `qr` and
// `datamatrix` are in because some suppliers label cartons with them; `pdf417`
// and `aztec` are deliberately out (ID cards and boarding passes -- they only
// give the detector more work to do on every frame).
export const RETAIL_BARCODE_TYPES = [
  'ean13',
  'ean8',
  'upc_a',
  'upc_e',
  'code128',
  'code39',
  'code93',
  'itf14',
  'codabar',
  'qr',
  'datamatrix',
] as const;

// Everything a scanner can send that isn't part of the code. Hardware wedge
// scanners are usually configured with a CR (or CRLF, or Tab) suffix so the
// receiving field knows the scan ended, and when that lands in a React Native
// `TextInput` the terminator arrives inside the value. Zero-width characters
// and other C0 controls turn up occasionally from mis-decodes.
//
// Tested by code point rather than a regex character class: the ranges involved
// are invisible characters that nobody can read -- or safely edit -- when
// written literally into a pattern.
function isNoise(codePoint: number): boolean {
  if (codePoint <= 0x20) return true; // space and every C0 control, incl. CR, LF, Tab
  if (codePoint === 0x7f) return true; // DEL
  if (codePoint >= 0x200b && codePoint <= 0x200d) return true; // zero-width space/non-joiner/joiner
  return codePoint === 0xfeff; // zero-width no-break space (BOM)
}

// Case is preserved: the stored value should round-trip exactly as the shop
// entered it (SKUs like "TSHIRT-BLU-M" are shown back to people). Matching is
// case-insensitive at comparison time instead -- see `resolveBarcode`.
export function normalizeBarcode(raw: string): string {
  let out = '';
  for (const char of raw) {
    if (!isNoise(char.codePointAt(0)!)) out += char;
  }
  return out;
}

// The one code equivalence that actually bites in practice: a 12-digit UPC-A
// and the 13-digit EAN-13 that is the same code with a leading zero. Android's
// ML Kit reports a UPC-A label as `ean13` with that zero prefixed; iOS reports
// it as `upc_a` without. So the same physical item scans as two different
// strings depending on the phone in the cashier's hand, and a lookup that only
// tried the literal string would miss half the time.
//
// UPC-E -> UPC-A expansion is knowingly not handled: it is a fiddly 6-to-11
// digit rule, and scanner firmware almost always expands it before we see it.
export function barcodeCandidates(code: string): string[] {
  const normalized = normalizeBarcode(code);
  if (!/^[0-9]+$/.test(normalized)) return [normalized];
  if (normalized.length === 12) return [normalized, `0${normalized}`];
  if (normalized.length === 13 && normalized.startsWith('0')) return [normalized, normalized.slice(1)];
  return [normalized];
}

// Standard GTIN mod-10 check digit, for lengths 8/12/13/14.
//
// Never used to REJECT a code. Plenty of shops print their own Code 39/128
// labels that carry no GTIN checksum at all, and refusing those would break the
// feature for exactly the shops most likely to rely on it. It only lets an
// unknown code be described accurately: "that doesn't look like a product
// barcode" reads very differently from "no product has barcode 5012345678900".
export function isValidGtinChecksum(code: string): boolean {
  if (!/^[0-9]+$/.test(code)) return false;
  if (![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  // Weights alternate 3,1,... counting back from the digit next to the check
  // digit, so which end gets the 3 depends on the length.
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    sum += digits[i] * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === check;
}

// Whether a string is plausibly a scanned code rather than a search phrase.
//
// This exists for one specific judgement: when someone presses Enter in the
// product search box and nothing matched, do we say "unknown barcode" or stay
// quiet? Typing "toner" and hitting Enter must not produce a scanner error, or
// the search box stops feeling like a search box.
export function looksLikeBarcode(code: string): boolean {
  // Judge spacing on the raw string -- normalization strips it, so a phrase
  // like "wool scarf" would otherwise pass as the code "woolscarf".
  if (/\s/.test(code.trim())) return false;
  const normalized = normalizeBarcode(code);
  if (normalized.length < 6) return false;
  return /^[0-9]+$/.test(normalized) || /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(normalized);
}

export type BarcodeMatchField = 'barcode' | 'sku';

export type BarcodeResolution =
  | { status: 'match'; product: Product; matchedOn: BarcodeMatchField }
  | { status: 'ambiguous'; products: Product[]; matchedOn: BarcodeMatchField }
  | { status: 'not-found'; code: string };

function matchesAny(value: string | null, candidates: string[]): boolean {
  if (!value) return false;
  const normalized = normalizeBarcode(value).toLowerCase();
  if (!normalized) return false;
  return candidates.some((candidate) => candidate.toLowerCase() === normalized);
}

// Resolves a scanned code against an already-loaded catalog.
//
// In-memory rather than a query because both POS and Inventory already hold the
// whole (location-scoped) product list in state, and a wedge scanner can emit
// several codes a second -- a round trip per scan would be visibly slow on shop
// wifi. Callers fall back to `findProductsByCode` only on a miss.
//
// Barcode always beats SKU: a barcode is the printed, scanned identity, while
// SKU is an internal label that merely happens to be typable. If one product's
// barcode and another's SKU both match, the barcode wins outright rather than
// the result depending on catalog order.
//
// `ambiguous` is never resolved by picking one. The unique index makes a literal
// duplicate barcode impossible, but two rows can still both match legitimately:
// one storing the UPC-A form and another the EAN-13 form of the same code, or
// two products sharing a SKU (which is not constrained). Guessing there is how
// a till rings up the wrong item.
export function resolveBarcode(products: readonly Product[], raw: string): BarcodeResolution {
  const candidates = barcodeCandidates(raw);
  const code = candidates[0];
  if (!code) return { status: 'not-found', code };

  for (const field of ['barcode', 'sku'] as const) {
    const hits = products.filter((product) => matchesAny(product[field], candidates));
    if (hits.length === 1) return { status: 'match', product: hits[0], matchedOn: field };
    if (hits.length > 1) return { status: 'ambiguous', products: hits, matchedOn: field };
  }
  return { status: 'not-found', code };
}

export type PosScanOutcome =
  | { kind: 'add'; product: Product }
  | { kind: 'out-of-stock'; product: Product }
  | { kind: 'exceeds-stock'; product: Product; inCart: number }
  | { kind: 'ambiguous'; products: Product[] }
  | { kind: 'unknown'; code: string };

// The POS-specific layer on top of `resolveBarcode`. Stock policy lives here
// rather than in the resolver because Inventory legitimately scans out-of-stock
// items -- it needs the same lookup with none of these rules.
//
// `product.stock` is already the right number without this function knowing
// anything about locations: POS lists its catalog scoped to the till's active
// location, so `stock` is what that store has, which is precisely what decides
// whether this till can sell it.
//
// `exceeds-stock` stops a continuous scan pushing quantity past what's on hand.
// `complete_sale` would refuse the sale at payment time anyway, and finding out
// then -- basket scanned, customer waiting -- is far worse than finding out on
// the scan that caused it.
export function posScanOutcome(
  products: readonly Product[],
  cart: readonly CartLine[],
  raw: string
): PosScanOutcome {
  const resolution = resolveBarcode(products, raw);
  if (resolution.status === 'not-found') return { kind: 'unknown', code: resolution.code };
  if (resolution.status === 'ambiguous') return { kind: 'ambiguous', products: resolution.products };

  const { product } = resolution;
  if (product.stock <= 0) return { kind: 'out-of-stock', product };
  const inCart = cart.find((line) => line.product.id === product.id)?.quantity ?? 0;
  if (inCart >= product.stock) return { kind: 'exceeds-stock', product, inCart };
  return { kind: 'add', product };
}

// What to tell someone about the scan that just happened. The screen that owns
// the scan decides the wording, because the same outcome means different things
// in POS ("added to the sale") and Inventory ("here it is") -- while the banner
// that renders it stays one component.
export type ScanFeedback = { tone: 'ok' | 'warn' | 'error'; message: string };

// Duplicate-frame suppression for camera scanning.
//
// `onBarcodeScanned` fires on every frame that contains a readable code -- 30+
// times a second while the cashier holds an item in view. Without a gate, one
// item becomes thirty cart lines.
export type ScanGate = { lastCode: string | null; lastAt: number; locked: boolean };

// Long enough that holding an item in frame yields one add; short enough that
// deliberately scanning the same item twice only needs a brief pause. This is
// the same bargain supermarket scanners strike.
export const SCAN_REPEAT_WINDOW_MS = 1500;

export function initialScanGate(): ScanGate {
  return { lastCode: null, lastAt: 0, locked: false };
}

export function shouldAcceptScan(
  gate: ScanGate,
  code: string,
  now: number,
  windowMs: number = SCAN_REPEAT_WINDOW_MS
): boolean {
  if (gate.locked) return false;
  const normalized = normalizeBarcode(code);
  if (!normalized) return false;
  // A DIFFERENT code is always accepted immediately -- the cashier moved on to
  // the next item, and making them wait out the window would be maddening.
  if (gate.lastCode !== normalized) return true;
  return now - gate.lastAt >= windowMs;
}

export function acceptScan(gate: ScanGate, code: string, now: number, mode: 'single' | 'continuous'): ScanGate {
  return {
    lastCode: normalizeBarcode(code),
    lastAt: now,
    // In single mode the gate latches shut, so the frames still arriving while
    // the modal animates away cannot produce a second scan.
    locked: mode === 'single',
  };
}
