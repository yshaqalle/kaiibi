import { buildReceiptHtml, buildReceiptText, merchantIdFor, type ReceiptData } from '@/lib/receipt';
import { receiptPayload, receiptShortCode } from '@/lib/qr';

const SALE_ID = '4f2a0193-c7d8-4e1b-9a2f-5c3d6e8b71a0';

function receipt(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    saleId: SALE_ID,
    shopName: 'Hodan Grocery',
    shopLogoUrl: null,
    locationName: null,
    shopCity: 'Mogadishu',
    shopNeighborhood: 'Hodan',
    shopContactPhone: null,
    shopHours: null,
    cashierName: null,
    zaadMerchantId: null,
    edahabMerchantId: null,
    returnPolicy: null,
    items: [{ name: 'Sparkling Water', quantity: 3, unitPriceCents: 225 }],
    payments: [{ method: 'cash', amountCents: 675, tenderedCents: 675, customerName: null, customerPhone: null, currencyCode: null, exchangeRate: null, foreignAmountCents: null, foreignChangeCents: null }],
    customer: { name: null, phone: null, email: null },
    totalCents: 675,
    createdAt: '2026-08-06T15:42:00.000Z',
    ...overrides,
  };
}

describe('merchantIdFor', () => {
  const withIds = receipt({ zaadMerchantId: '618 4471', edahabMerchantId: '906 2210' });

  it('returns the id matching the method that was actually used', () => {
    expect(merchantIdFor(withIds, 'zaad')).toBe('618 4471');
    expect(merchantIdFor(withIds, 'edahab')).toBe('906 2210');
  });

  it('has nothing to print for cash or other', () => {
    expect(merchantIdFor(withIds, 'cash')).toBeNull();
    expect(merchantIdFor(withIds, 'other')).toBeNull();
  });

  // An owner who tabbed through the field shouldn't get "Merchant ID" printed
  // with nothing after it.
  it('treats whitespace-only as unset', () => {
    expect(merchantIdFor(receipt({ zaadMerchantId: '   ' }), 'zaad')).toBeNull();
  });

  it('trims what it does print', () => {
    expect(merchantIdFor(receipt({ zaadMerchantId: ' 618 4471 ' }), 'zaad')).toBe('618 4471');
  });
});

describe('buildReceiptHtml', () => {
  it('prints the short code and a QR encoding the whole sale id', () => {
    const html = buildReceiptHtml(receipt());
    expect(html).toContain(receiptShortCode(SALE_ID));
    // The QR is a path, so assert on the symbol being present and sized rather
    // than on its bits -- src/lib/qr.test.ts covers the encoding itself.
    expect(html).toContain('<svg viewBox="0 0 33 33"');
    expect(receiptPayload(SALE_ID)).toBe('KR-4F2A0193C7D84E1B9A2F5C3D6E8B71A0');
  });

  // Both or neither: a printed number with no code beside it invites someone
  // to try typing a uuid.
  it('omits both the code line and the QR when there is no sale id', () => {
    const html = buildReceiptHtml(receipt({ saleId: null }));
    expect(html).not.toContain('Receipt #');
    expect(html).not.toContain('<svg');
  });

  it('is byte-identical across renders, so a reprint matches the original', () => {
    const data = receipt();
    expect(buildReceiptHtml(data)).toBe(buildReceiptHtml(data));
  });

  it('prints a merchant id under the mobile-money line that used it', () => {
    const html = buildReceiptHtml(
      receipt({
        zaadMerchantId: '618 4471',
        edahabMerchantId: '906 2210',
        payments: [
          { method: 'zaad', amountCents: 675, tenderedCents: null, customerName: null, customerPhone: null, currencyCode: null, exchangeRate: null, foreignAmountCents: null, foreignChangeCents: null },
        ],
      })
    );
    expect(html).toContain('Merchant ID 618 4471');
    // The e-Dahab number is on file but that method wasn't used on this sale.
    expect(html).not.toContain('906 2210');
  });

  it('prints no merchant line on a cash sale even when the numbers are set', () => {
    const html = buildReceiptHtml(receipt({ zaadMerchantId: '618 4471', edahabMerchantId: '906 2210' }));
    expect(html).not.toContain('Merchant ID');
  });

  describe('Kaiibi branding', () => {
    it('prints by default, when nothing has resolved the flag', () => {
      expect(buildReceiptHtml(receipt())).toContain('Powered by');
    });

    it('still prints when explicitly enabled', () => {
      expect(buildReceiptHtml(receipt({ showKaiibiBranding: true }))).toContain('Powered by');
    });

    // The only way to lose the mark: a plan granting receipt_branding_removal.
    it('is removed only when the flag is explicitly false', () => {
      expect(buildReceiptHtml(receipt({ showKaiibiBranding: false }))).not.toContain('Powered by');
    });
  });

  it('escapes shop-supplied text rather than letting it close a tag', () => {
    const html = buildReceiptHtml(receipt({ shopName: 'Hodan <script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops the optional blocks a bare cash sale has none of', () => {
    const html = buildReceiptHtml(receipt());
    expect(html).not.toContain('Cashier');
    expect(html).not.toContain('Customer');
    expect(html).not.toContain('Subtotal');
    expect(html).not.toContain('Tax (');
  });

  it('shows the discount breakdown and the per-line discount when there is one', () => {
    const html = buildReceiptHtml(
      receipt({
        items: [{ name: 'Almond Croissant', quantity: 2, unitPriceCents: 375, discountCents: 50 }],
        subtotalCents: 750,
        discountCents: 50,
        totalCents: 700,
      })
    );
    expect(html).toContain('Subtotal');
    expect(html).toContain('discount &minus;0.50');
  });
});

describe('buildReceiptText', () => {
  it('carries the short code, since a WhatsApp receipt has no QR to scan', () => {
    expect(buildReceiptText(receipt())).toContain('Receipt #4F2A-0193');
  });

  it('carries the merchant id under the payment that used it', () => {
    const text = buildReceiptText(
      receipt({
        zaadMerchantId: '618 4471',
        payments: [
          { method: 'zaad', amountCents: 675, tenderedCents: null, customerName: null, customerPhone: null, currencyCode: null, exchangeRate: null, foreignAmountCents: null, foreignChangeCents: null },
        ],
      })
    );
    expect(text).toContain('Merchant ID 618 4471');
  });

  it('omits the code line when there is no sale id', () => {
    expect(buildReceiptText(receipt({ saleId: null }))).not.toContain('Receipt #');
  });
});
