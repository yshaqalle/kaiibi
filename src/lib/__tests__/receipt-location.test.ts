import { buildReceiptFromSale } from '@/lib/receipt';
import type { Sale } from '@/types/models';

// A receipt is proof of a transaction at a PLACE. Once a business has two
// branches, printing the company's registered address on a receipt from the
// other side of town sends the customer to the wrong door -- these cover the
// resolution that prevents that.

const SHOP = {
  name: 'Ka Iibi Store',
  logoUrl: null,
  city: 'Hargeisa',
  neighborhood: 'Registered Office',
  contactPhone: '+252 63 111 1111',
  returnPolicy: null,
};

const AIRPORT_ROAD = {
  name: 'Airport Road',
  city: 'Hargeisa',
  neighborhood: 'Airport Road',
  contactPhone: '+252 63 222 2222',
  openingHours: {},
};

function makeSale(): Sale {
  return {
    id: 's1',
    shopId: 'shop1',
    locationId: 'loc1',
    createdBy: null,
    paymentMethod: 'cash',
    paymentNote: null,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
    customerId: null,
    cashierName: null,
    discountCents: 0,
    taxCents: 0,
    taxRatePercent: null,
    totalCents: 1000,
    itemCount: 1,
    createdAt: new Date().toISOString(),
    items: [{ id: 'i1', saleId: 's1', productId: 'p1', productName: 'Soap', unitPriceCents: 1000, quantity: 1, lineTotalCents: 1000, discountCents: 0, unitCostCents: null }],
    payments: [],
    edits: [],
    refunds: [],
  };
}

describe('buildReceiptFromSale location resolution', () => {
  it("prints the selling branch's address and phone, not the business's", () => {
    const receipt = buildReceiptFromSale(makeSale(), SHOP, AIRPORT_ROAD);
    expect(receipt.shopNeighborhood).toBe('Airport Road');
    expect(receipt.shopContactPhone).toBe('+252 63 222 2222');
  });

  // The single-location shops that are the norm, and any caller that hasn't
  // resolved a location yet: falling back to the business's own details is
  // incomplete at worst, never wrong.
  it('falls back to the shop when no location is supplied', () => {
    const receipt = buildReceiptFromSale(makeSale(), SHOP);
    expect(receipt.shopNeighborhood).toBe('Registered Office');
    expect(receipt.shopContactPhone).toBe('+252 63 111 1111');
  });

  it('treats an explicitly null location the same as an omitted one', () => {
    expect(buildReceiptFromSale(makeSale(), SHOP, null).shopNeighborhood).toBe('Registered Office');
  });

  // A branch that hasn't filled in its own address shouldn't blank the receipt
  // -- each field falls back independently.
  it('falls back per field when the branch leaves one blank', () => {
    const receipt = buildReceiptFromSale(makeSale(), SHOP, { ...AIRPORT_ROAD, contactPhone: null });
    expect(receipt.shopNeighborhood).toBe('Airport Road');
    expect(receipt.shopContactPhone).toBe('+252 63 111 1111');
  });

  describe('branch name', () => {
    // Printing "Main" under the shop's own name tells a customer nothing, so
    // the name is suppressed until there is a second branch to tell apart.
    it('is omitted by default', () => {
      expect(buildReceiptFromSale(makeSale(), SHOP, AIRPORT_ROAD).locationName).toBeNull();
    });

    it('is printed when the caller asks for it', () => {
      expect(buildReceiptFromSale(makeSale(), SHOP, AIRPORT_ROAD, true).locationName).toBe('Airport Road');
    });

    it('stays null when asked for but no location was resolved', () => {
      expect(buildReceiptFromSale(makeSale(), SHOP, null, true).locationName).toBeNull();
    });
  });
});
