import { rollUpByVendor } from '@/lib/invoice-reporting';
import type { Invoice } from '@/types/models';

const TODAY = new Date('2026-09-05T12:00:00Z');

const bill = (over: Partial<Invoice>): Invoice =>
  ({
    id: Math.random().toString(36).slice(2),
    shopId: 's', locationId: null, vendorId: null, vendorName: 'Skinfood', vendorPhone: null,
    invoiceNumber: '1', category: 'stock', description: null,
    issuedOn: '2026-08-01', dueOn: '2026-09-30', amountCents: 10000, paidCents: 0,
    ...over,
  }) as Invoice;

describe('what the shop owes, by supplier', () => {
  it('adds a supplier’s open bills into one row', () => {
    const rows = rollUpByVendor([bill({}), bill({ amountCents: 5000 })], TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vendor: 'Skinfood', openCount: 2, owedCents: 15000 });
  });

  it('counts only what is still owed, not what the bill was for', () => {
    // A part-paid bill contributes its BALANCE. Using the face value would
    // overstate the exposure by everything already paid.
    const rows = rollUpByVendor([bill({ amountCents: 10000, paidCents: 6000 })], TODAY);
    expect(rows[0].owedCents).toBe(4000);
  });

  it('leaves settled bills out entirely', () => {
    const rows = rollUpByVendor([bill({ amountCents: 10000, paidCents: 10000 }), bill({ amountCents: 2000 })], TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ openCount: 1, owedCents: 2000 });
  });

  it('splits overdue from not yet due, and the two add up to the total', () => {
    const rows = rollUpByVendor(
      [bill({ dueOn: '2026-08-14' }), bill({ dueOn: '2026-12-01', amountCents: 30000 })],
      TODAY
    );
    const [row] = rows;
    expect(row.overdueCents).toBe(10000);
    expect(row.notYetDueCents).toBe(30000);
    expect(row.overdueCents + row.notYetDueCents).toBe(row.owedCents);
  });

  it('pools bills with no supplier rather than dropping them', () => {
    // Money owed to nobody-in-particular is still money owed, and dropping it
    // would stop this reconciling with the tab's own outstanding total.
    const rows = rollUpByVendor([bill({ vendorName: null }), bill({ vendorName: '   ' })], TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vendor: 'No supplier named', openCount: 2 });
  });

  it('reconciles with the outstanding total on the tab above it', () => {
    const bills = [bill({}), bill({ vendorName: 'Landlord', amountCents: 32000 }), bill({ amountCents: 500, paidCents: 500 })];
    const rows = rollUpByVendor(bills, TODAY);
    const summed = rows.reduce((n, r) => n + r.owedCents, 0);
    expect(summed).toBe(10000 + 32000);
  });

  it('puts the biggest exposure first, and breaks ties by name so it does not reshuffle', () => {
    const rows = rollUpByVendor(
      [bill({ vendorName: 'Zed', amountCents: 1000 }), bill({ vendorName: 'Abe', amountCents: 1000 }), bill({ vendorName: 'Big', amountCents: 9000 })],
      TODAY
    );
    expect(rows.map((r) => r.vendor)).toEqual(['Big', 'Abe', 'Zed']);
  });
});
