import {
  acceptScan,
  barcodeCandidates,
  initialScanGate,
  isValidGtinChecksum,
  looksLikeBarcode,
  normalizeBarcode,
  posScanOutcome,
  resolveBarcode,
  shouldAcceptScan,
} from '@/lib/barcode';
import type { CartLine, Product } from '@/types/models';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1', shopId: 's1', name: 'Toner', description: null, sku: null, barcode: null, brand: null,
    category: null, tags: [], supplierName: null, costCents: null, priceCents: 2400, stock: 10,
    reorderLevel: null, shelfNumber: null, expiryDate: null, batchNumber: null, imageUrl: null,
    isListedOnline: false, createdAt: '', updatedAt: '', ...overrides,
  };
}

function line(product: Product, quantity: number): CartLine {
  return { product, quantity };
}

describe('normalizeBarcode', () => {
  it('strips the CR/LF suffix a wedge scanner appends', () => {
    expect(normalizeBarcode('5012345678900\r\n')).toBe('5012345678900');
  });

  it('strips tabs, spaces and zero-width characters', () => {
    expect(normalizeBarcode('\t 501 234​5678900 ﻿')).toBe('5012345678900');
  });

  it('preserves case so the stored value round-trips', () => {
    expect(normalizeBarcode(' TShirt-Blu-M ')).toBe('TShirt-Blu-M');
  });

  it('reduces a whitespace-only value to empty', () => {
    expect(normalizeBarcode('  \r\n\t ')).toBe('');
  });
});

describe('barcodeCandidates', () => {
  it('offers the EAN-13 form of a 12-digit UPC-A', () => {
    expect(barcodeCandidates('012345678905')).toEqual(['012345678905', '0012345678905']);
  });

  it('offers the UPC-A form of a zero-prefixed EAN-13', () => {
    expect(barcodeCandidates('0012345678905')).toEqual(['0012345678905', '012345678905']);
  });

  it('leaves an EAN-13 that does not start with zero alone', () => {
    expect(barcodeCandidates('5012345678900')).toEqual(['5012345678900']);
  });

  it('leaves an 8-digit EAN-8 alone', () => {
    expect(barcodeCandidates('50123452')).toEqual(['50123452']);
  });

  it('leaves a non-numeric code alone', () => {
    expect(barcodeCandidates('TSHIRT-BLU-M')).toEqual(['TSHIRT-BLU-M']);
  });
});

describe('isValidGtinChecksum', () => {
  it('accepts a valid EAN-13', () => {
    expect(isValidGtinChecksum('5012345678900')).toBe(true);
  });

  it('accepts a valid UPC-A', () => {
    expect(isValidGtinChecksum('012345678905')).toBe(true);
  });

  it('rejects a code with a flipped digit', () => {
    expect(isValidGtinChecksum('5012345678901')).toBe(false);
  });

  it('rejects a length that is not a GTIN length', () => {
    expect(isValidGtinChecksum('501234567')).toBe(false);
  });

  it('rejects a non-numeric code', () => {
    expect(isValidGtinChecksum('TSHIRT-BLU-M')).toBe(false);
  });
});

describe('looksLikeBarcode', () => {
  it('accepts a 13-digit code', () => {
    expect(looksLikeBarcode('5012345678900')).toBe(true);
  });

  it('accepts an alphanumeric SKU', () => {
    expect(looksLikeBarcode('TSHIRT-BLU-M')).toBe(true);
  });

  it('rejects a short search word', () => {
    expect(looksLikeBarcode('toner')).toBe(false);
  });

  // The rule that keeps the POS search box from crying "unknown barcode" every
  // time someone searches for a product by name and presses Enter.
  it('rejects a multi-word phrase even when it is long', () => {
    expect(looksLikeBarcode('wool scarf')).toBe(false);
  });
});

describe('resolveBarcode', () => {
  const toner = makeProduct({ id: 'p1', name: 'Toner', barcode: '5012345678900' });
  const scarf = makeProduct({ id: 'p2', name: 'Scarf', sku: 'SCARF-01' });

  it('matches on barcode', () => {
    const result = resolveBarcode([toner, scarf], '5012345678900');
    expect(result).toMatchObject({ status: 'match', matchedOn: 'barcode' });
    expect(result.status === 'match' && result.product.id).toBe('p1');
  });

  it('falls back to SKU when no barcode matches, case-insensitively', () => {
    const result = resolveBarcode([toner, scarf], 'scarf-01');
    expect(result).toMatchObject({ status: 'match', matchedOn: 'sku' });
    expect(result.status === 'match' && result.product.id).toBe('p2');
  });

  it('ignores the scanner suffix on the incoming code', () => {
    expect(resolveBarcode([toner], '5012345678900\r\n')).toMatchObject({ status: 'match' });
  });

  it('ignores stray whitespace in the STORED value too', () => {
    const messy = makeProduct({ id: 'p9', barcode: ' 5012345678900 ' });
    expect(resolveBarcode([messy], '5012345678900')).toMatchObject({ status: 'match' });
  });

  // A UPC-A scanned on iOS must find the product an Android till stored as
  // EAN-13, and vice versa.
  it('matches across the UPC-A / EAN-13 leading zero', () => {
    const upc = makeProduct({ id: 'p3', barcode: '012345678905' });
    expect(resolveBarcode([upc], '0012345678905')).toMatchObject({ status: 'match' });
    const ean = makeProduct({ id: 'p4', barcode: '0012345678905' });
    expect(resolveBarcode([ean], '012345678905')).toMatchObject({ status: 'match' });
  });

  it('prefers a barcode match over another product whose SKU matches', () => {
    const bySku = makeProduct({ id: 'sku-owner', sku: '5012345678900' });
    const result = resolveBarcode([bySku, toner], '5012345678900');
    expect(result).toMatchObject({ status: 'match', matchedOn: 'barcode' });
    expect(result.status === 'match' && result.product.id).toBe('p1');
  });

  it('reports ambiguity rather than guessing', () => {
    const a = makeProduct({ id: 'a', barcode: '012345678905' });
    const b = makeProduct({ id: 'b', barcode: '0012345678905' });
    const result = resolveBarcode([a, b], '012345678905');
    expect(result.status).toBe('ambiguous');
    expect(result.status === 'ambiguous' && result.products).toHaveLength(2);
  });

  it('returns not-found for an unknown code', () => {
    expect(resolveBarcode([toner], '9999999999999')).toEqual({ status: 'not-found', code: '9999999999999' });
  });

  // Products with a null barcode must not all match the empty string.
  it('returns not-found for an empty code', () => {
    expect(resolveBarcode([scarf], '   ')).toEqual({ status: 'not-found', code: '' });
  });
});

describe('posScanOutcome', () => {
  const toner = makeProduct({ id: 'p1', barcode: '5012345678900', stock: 2 });

  it('adds a product that is in stock', () => {
    expect(posScanOutcome([toner], [], '5012345678900')).toEqual({ kind: 'add', product: toner });
  });

  it('refuses a product with no stock', () => {
    const empty = makeProduct({ id: 'p2', barcode: '111111', stock: 0 });
    expect(posScanOutcome([empty], [], '111111')).toEqual({ kind: 'out-of-stock', product: empty });
  });

  // Catching this at scan time rather than letting complete_sale reject the
  // whole basket at payment.
  it('refuses to take the cart past the stock on hand', () => {
    expect(posScanOutcome([toner], [line(toner, 2)], '5012345678900')).toEqual({
      kind: 'exceeds-stock', product: toner, inCart: 2,
    });
  });

  it('still adds while the cart is under the stock on hand', () => {
    expect(posScanOutcome([toner], [line(toner, 1)], '5012345678900')).toEqual({ kind: 'add', product: toner });
  });

  it('passes ambiguity and unknown codes through', () => {
    const a = makeProduct({ id: 'a', barcode: '012345678905' });
    const b = makeProduct({ id: 'b', barcode: '0012345678905' });
    expect(posScanOutcome([a, b], [], '012345678905').kind).toBe('ambiguous');
    expect(posScanOutcome([toner], [], '404040404040')).toEqual({ kind: 'unknown', code: '404040404040' });
  });
});

describe('scan gate', () => {
  it('accepts the first scan', () => {
    expect(shouldAcceptScan(initialScanGate(), '5012345678900', 1000)).toBe(true);
  });

  it('ignores the same code within the repeat window', () => {
    const gate = acceptScan(initialScanGate(), '5012345678900', 1000, 'continuous');
    expect(shouldAcceptScan(gate, '5012345678900', 2000)).toBe(false);
  });

  it('accepts the same code once the window has passed', () => {
    const gate = acceptScan(initialScanGate(), '5012345678900', 1000, 'continuous');
    expect(shouldAcceptScan(gate, '5012345678900', 2600)).toBe(true);
  });

  // Scanning a basket must not make the cashier wait between different items.
  it('accepts a different code immediately', () => {
    const gate = acceptScan(initialScanGate(), '5012345678900', 1000, 'continuous');
    expect(shouldAcceptScan(gate, '111111111111', 1010)).toBe(true);
  });

  it('latches shut after a single-mode scan', () => {
    const gate = acceptScan(initialScanGate(), '5012345678900', 1000, 'single');
    expect(gate.locked).toBe(true);
    expect(shouldAcceptScan(gate, '111111111111', 9999)).toBe(false);
  });

  it('treats a code that normalizes to nothing as no scan at all', () => {
    expect(shouldAcceptScan(initialScanGate(), '  \r\n', 1000)).toBe(false);
  });
});
