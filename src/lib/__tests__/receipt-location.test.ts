import { buildReceiptFromSale, storeNameFor } from '@/lib/receipt';
import type { Sale } from '@/types/models';

// A receipt is proof of a transaction at a PLACE. Once a business has two
// branches, printing the company's registered address on a receipt from the
// other side of town sends the customer to the wrong door -- these cover the
// resolution that prevents that.

const SHOP = {
  name: 'Ka Iibi Store',
  logoUrl: null,
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
    pointsEarned: 0,
    pointsRedeemed: 0,
    pointsRedeemedCents: 0,
    loyaltyPointsPerUsd: null,
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
  it("prints the selling branch's address and phone", () => {
    const receipt = buildReceiptFromSale(makeSale(), SHOP, AIRPORT_ROAD);
    expect(receipt.shopNeighborhood).toBe('Airport Road');
    expect(receipt.shopContactPhone).toBe('+252 63 222 2222');
  });

  // The location is the ONLY source of the address -- the shop has none. An
  // unresolved location must print nothing rather than something stale: a
  // receipt with no address is incomplete, one with the wrong address sends a
  // customer to the wrong door.
  it('prints no address at all when no location is supplied', () => {
    const receipt = buildReceiptFromSale(makeSale(), SHOP);
    expect(receipt.shopCity).toBeNull();
    expect(receipt.shopNeighborhood).toBeNull();
    expect(receipt.shopContactPhone).toBeNull();
  });

  it('treats an explicitly null location the same as an omitted one', () => {
    expect(buildReceiptFromSale(makeSale(), SHOP, null).shopNeighborhood).toBeNull();
  });

  // A branch that leaves one field blank blanks only that line -- the rest of
  // its address still prints.
  it('omits only the field the branch left blank', () => {
    const receipt = buildReceiptFromSale(makeSale(), SHOP, { ...AIRPORT_ROAD, contactPhone: null });
    expect(receipt.shopNeighborhood).toBe('Airport Road');
    expect(receipt.shopContactPhone).toBeNull();
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

describe('storeNameFor', () => {
  // The case from a real receipt: a shop's first store is created named after
  // the business, so once a second store exists and names start printing, the
  // header showed the same words twice.
  it('omits the store name when it matches the business name', () => {
    expect(storeNameFor('Jaalala Skincare', 'Jaalala Skincare', true)).toBeNull();
  });

  it('ignores surrounding whitespace when comparing', () => {
    expect(storeNameFor('Jaalala Skincare', '  Jaalala Skincare  ', true)).toBeNull();
  });

  it('prints the store name once it actually differs', () => {
    expect(storeNameFor('Jaalala Skincare', 'Jaalala 2', true)).toBe('Jaalala 2');
  });

  it('prints nothing for a single-store shop, whatever the names', () => {
    expect(storeNameFor('Jaalala Skincare', 'Jaalala 2', false)).toBeNull();
  });

  it('prints nothing when no store was resolved', () => {
    expect(storeNameFor('Jaalala Skincare', null, true)).toBeNull();
  });
});
