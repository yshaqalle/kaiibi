import { buildReceiptFromSale, buildReceiptHtml, buildReceiptText, type ReceiptData } from '@/lib/receipt';
import type { Sale, SalePayment } from '@/types/models';

// A receipt is the only part of this feature the customer takes home, so what it
// says about money still owed has to be right in all three renderings -- the
// on-screen modal reads the same ReceiptData these two builders do, and a
// WhatsApped receipt that disagreed with the printed one would be worse than
// either.

function receipt(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    saleId: '4f2a0193-c7d8-4e1b-9a2f-5c3d6e8b71a0',
    shopName: 'Hodan Grocery',
    shopLogoUrl: null,
    locationName: null,
    shopCity: null,
    shopNeighborhood: null,
    shopContactPhone: null,
    shopHours: null,
    cashierName: null,
    zaadMerchantId: null,
    edahabMerchantId: null,
    returnPolicy: null,
    items: [{ name: 'Sparkling Water', quantity: 3, unitPriceCents: 225 }],
    payments: [
      { method: 'cash', amountCents: 5000, tenderedCents: 5000, customerName: null, customerPhone: null,
        currencyCode: null, exchangeRate: null, foreignAmountCents: null, foreignChangeCents: null },
    ],
    customer: { name: 'Farah Hassan', phone: null, email: null },
    totalCents: 8474,
    createdAt: '2026-08-16T15:42:00.000Z',
    ...overrides,
  };
}

describe('a part-paid receipt', () => {
  it('prints what is still owed, and whose debt it is', () => {
    const text = buildReceiptText(receipt({ balanceDueCents: 3474 }));
    expect(text).toContain('BALANCE DUE: $34.74');
    // The name is on the balance line itself, not only in the CUSTOMER block:
    // this is the half that comes back over the counter when they pay.
    expect(text).toContain('Owed by Farah Hassan');
  });

  it('leaves the total alone -- it is what the goods came to', () => {
    const text = buildReceiptText(receipt({ balanceDueCents: 3474 }));
    expect(text).toContain('TOTAL: $84.74');
  });

  it('says the same thing in the printed and shared copies', () => {
    const html = buildReceiptHtml(receipt({ balanceDueCents: 3474 }));
    expect(html).toContain('BALANCE DUE');
    expect(html).toContain('$34.74');
    expect(html).toContain('Owed by Farah Hassan');
  });

  it('prints no balance line on an ordinary paid sale', () => {
    const paid = receipt();
    expect(buildReceiptText(paid)).not.toContain('BALANCE DUE');
    expect(buildReceiptHtml(paid)).not.toContain('BALANCE DUE');
  });

  it('prints no balance line when the figure is zero rather than absent', () => {
    const paid = receipt({ balanceDueCents: 0 });
    expect(buildReceiptText(paid)).not.toContain('BALANCE DUE');
  });

});

const sale = (overrides: Partial<Sale> = {}): Sale =>
  ({
    id: 's1',
    totalCents: 8474,
    taxCents: 0,
    taxRatePercent: null,
    pointsRedeemed: 0,
    pointsRedeemedCents: 0,
    pointsEarned: 0,
    cashierName: null,
    customerName: 'Farah Hassan',
    customerPhone: null,
    customerEmail: null,
    createdAt: '2026-08-16T15:42:00.000Z',
    items: [],
    payments: [],
    ...overrides,
  }) as unknown as Sale;

const paid = (amountCents: number): SalePayment =>
  ({ method: 'cash', amountCents }) as unknown as SalePayment;

const shop = { name: 'Hodan Grocery', logoUrl: null, returnPolicy: null };

describe('buildReceiptFromSale', () => {
  it('reads the balance off the sale, so a reprint shows the same figure', () => {
    const built = buildReceiptFromSale(sale({ settledAt: null, payments: [paid(5000)] }), shop);
    expect(built.balanceDueCents).toBe(3474);
  });

  it('shows it CURRENT: a sale since paid off reprints with no balance', () => {
    // Settlements live in sale.payments alongside the till's own, so the figure
    // shrinks as the customer pays rather than freezing at the original.
    const built = buildReceiptFromSale(sale({ settledAt: null, payments: [paid(5000), paid(3474)] }), shop);
    expect(built.balanceDueCents).toBe(0);
  });

  it('invents no debt when the payments were never loaded', () => {
    // The bug this guard exists for: mapSaleRow coerces a missing sale_payments
    // join to `[]`, which is indistinguishable from "nothing was ever paid". A
    // settled sale read by a caller that did not select its payments would
    // otherwise print BALANCE DUE $84.74, with the customer's name on it, for a
    // sale they paid in full.
    const built = buildReceiptFromSale(sale({ settledAt: '2026-08-16T15:45:00.000Z', payments: [] }), shop);
    expect(built.balanceDueCents).toBe(0);
  });

  it('treats an unselected settled_at as settled, not as owed', () => {
    // Same direction of failure: omitting a line beats inventing money owed.
    const built = buildReceiptFromSale(sale({ payments: [] }), shop);
    expect(built.balanceDueCents).toBe(0);
  });

  it('owes the whole sale when nothing was ever paid on it', () => {
    const built = buildReceiptFromSale(sale({ settledAt: null, payments: [] }), shop);
    expect(built.balanceDueCents).toBe(8474);
  });
});
