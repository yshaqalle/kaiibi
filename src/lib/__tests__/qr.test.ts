import {
  qrModules,
  qrPathData,
  qrSvg,
  qrViewBox,
  receiptPayload,
  receiptShortCode,
  RECEIPT_CODE_PREFIX,
} from '@/lib/qr';

const SALE_ID = '4f2a0193-c7d8-4e1b-9a2f-5c3d6e8b71a0';

describe('receiptPayload', () => {
  it('strips the uuid dashes and uppercases, so the payload stays in QR alphanumeric mode', () => {
    expect(receiptPayload(SALE_ID)).toBe('KR-4F2A0193C7D84E1B9A2F5C3D6E8B71A0');
  });

  // The reason the whole thing fits a 25x25 symbol. Lowercase or any character
  // outside this set silently falls back to byte mode and a bigger code.
  it('emits only characters QR alphanumeric mode can encode', () => {
    const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]+$/;
    expect(receiptPayload(SALE_ID)).toMatch(ALPHANUMERIC);
  });

  it('is prefixed so a scan handler can tell a receipt from a product barcode', () => {
    expect(receiptPayload(SALE_ID).startsWith(RECEIPT_CODE_PREFIX)).toBe(true);
  });

  it('is stable across calls -- a reprint must produce the same code', () => {
    expect(receiptPayload(SALE_ID)).toBe(receiptPayload(SALE_ID));
  });
});

describe('receiptShortCode', () => {
  it('takes eight characters of the id, hyphenated for reading aloud', () => {
    expect(receiptShortCode(SALE_ID)).toBe('4F2A-0193');
  });

  it('returns a too-short id as-is rather than padding it with filler', () => {
    expect(receiptShortCode('4f2a')).toBe('4F2A');
  });
});

describe('qrModules', () => {
  it('encodes a receipt payload in a 25x25 symbol (version 2)', () => {
    const modules = qrModules(receiptPayload(SALE_ID));
    expect(modules).toHaveLength(25);
    expect(modules[0]).toHaveLength(25);
  });

  // The three finder patterns are what a scanner locates first. If these are
  // wrong the symbol is unreadable no matter what the data bits say.
  it('places finder patterns in three corners', () => {
    const m = qrModules(receiptPayload(SALE_ID));
    const last = m.length - 1;
    const isFinder = (top: number, left: number) =>
      m[top][left] && m[top][left + 6] && m[top + 6][left] && !m[top + 1][left + 1];
    expect(isFinder(0, 0)).toBe(true);
    expect(isFinder(0, last - 6)).toBe(true);
    expect(isFinder(last - 6, 0)).toBe(true);
  });

  it('is deterministic for the same payload', () => {
    expect(qrModules(receiptPayload(SALE_ID))).toEqual(qrModules(receiptPayload(SALE_ID)));
  });

  it('produces different symbols for different sales', () => {
    const a = qrModules(receiptPayload(SALE_ID));
    const b = qrModules(receiptPayload('7b100044-e2a9-4c6f-8d3b-1e5a7c9f2d40'));
    expect(a).not.toEqual(b);
  });
});

describe('qrPathData / qrViewBox', () => {
  it('offsets every module by the quiet zone the spec requires', () => {
    const modules = qrModules(receiptPayload(SALE_ID));
    // The top-left finder's own corner module sits at 0,0 in the matrix, so
    // with a 4-module quiet zone its path command starts at 4,4.
    expect(qrPathData(modules).startsWith('M4 4h1v1h-1z')).toBe(true);
  });

  it('sizes the viewBox to include the quiet zone on both sides', () => {
    const modules = qrModules(receiptPayload(SALE_ID));
    expect(qrViewBox(modules)).toBe('0 0 33 33');
  });

  it('emits one command per dark module', () => {
    const modules = qrModules(receiptPayload(SALE_ID));
    const dark = modules.flat().filter(Boolean).length;
    expect(qrPathData(modules).match(/M/g)).toHaveLength(dark);
  });
});

describe('qrSvg', () => {
  it('renders a self-contained symbol at the requested pixel size', () => {
    const svg = qrSvg(receiptPayload(SALE_ID), 60);
    expect(svg).toContain('viewBox="0 0 33 33"');
    expect(svg).toContain('width="60" height="60"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('<path fill="#111111"');
  });
});
