import {
  bestPromotionForProduct,
  discountAmountCents,
  isPromotionLive,
  lineDiscountCents,
  promotionLiveIssue,
} from '@/lib/discounts';
import type { CartLine, Product, Promotion } from '@/types/models';

const AUG_14 = Date.parse('2026-08-14T10:00:00Z');

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1', shopId: 's1', name: 'Canvas shoes', description: null, sku: null, barcode: null,
    brand: null, category: null, tags: [], supplierName: null, costCents: null, priceCents: 1800,
    stock: 10, reorderLevel: null, shelfNumber: null, expiryDate: null, batchNumber: null,
    imageUrl: null, isListedOnline: false, createdAt: '', updatedAt: '', ...overrides,
  };
}

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 'promo1', shopId: 's1', locationId: null, name: 'Eid weekend',
    discountType: 'percentage', discountValue: 20, scope: 'store', scopeValue: null,
    active: true, startsAt: null, endsAt: null, autoApply: true, archivedAt: null,
    createdAt: '', ...overrides,
  };
}

describe('isPromotionLive', () => {
  it('is live with no window at all', () => {
    expect(isPromotionLive(makePromotion(), AUG_14)).toBe(true);
  });

  it('is not live before its start', () => {
    const promo = makePromotion({ startsAt: '2026-08-18T08:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(false);
  });

  it('is live once the start has passed', () => {
    const promo = makePromotion({ startsAt: '2026-08-13T08:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(true);
  });

  it('is not live after its end', () => {
    const promo = makePromotion({ endsAt: '2026-08-10T21:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(false);
  });

  it('is live inside a closed window', () => {
    const promo = makePromotion({ startsAt: '2026-08-13T08:00:00Z', endsAt: '2026-08-16T21:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(true);
  });

  it('treats the end instant as over', () => {
    const promo = makePromotion({ endsAt: '2026-08-14T10:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(false);
  });

  it('is not live when inactive, however open the window', () => {
    const promo = makePromotion({ active: false });
    expect(isPromotionLive(promo, AUG_14)).toBe(false);
  });

  it('is not live when archived', () => {
    const promo = makePromotion({ archivedAt: '2026-09-01T00:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(false);
  });
});

describe('promotionLiveIssue', () => {
  it('is null for a live promotion', () => {
    expect(promotionLiveIssue(makePromotion(), AUG_14)).toBeNull();
  });

  it('names the promotion when it has ended', () => {
    const promo = makePromotion({ name: 'Eid weekend', endsAt: '2026-08-10T21:00:00Z' });
    expect(promotionLiveIssue(promo, AUG_14)).toBe('"Eid weekend" has ended.');
  });

  it('names the promotion when it has been paused', () => {
    const promo = makePromotion({ name: 'Eid weekend', active: false });
    expect(promotionLiveIssue(promo, AUG_14)).toBe('"Eid weekend" has been paused and no longer runs at the till.');
  });

  it('names the promotion when it has been archived', () => {
    const promo = makePromotion({ name: 'Eid weekend', archivedAt: '2026-09-01T00:00:00Z' });
    expect(promotionLiveIssue(promo, AUG_14)).toBe('"Eid weekend" has been archived and no longer runs at the till.');
  });

  it('names the promotion when it has not started yet', () => {
    const promo = makePromotion({ name: 'Eid weekend', startsAt: '2026-08-18T08:00:00Z' });
    expect(promotionLiveIssue(promo, AUG_14)).toBe('"Eid weekend" hasn\'t started yet.');
  });

  it('archived wins over paused when both are true', () => {
    const promo = makePromotion({ name: 'Eid weekend', active: false, archivedAt: '2026-09-01T00:00:00Z' });
    expect(promotionLiveIssue(promo, AUG_14)).toBe('"Eid weekend" has been archived and no longer runs at the till.');
  });
});

describe('bestPromotionForProduct', () => {
  it('ignores a promotion outside its window', () => {
    const promo = makePromotion({ endsAt: '2026-08-10T21:00:00Z' });
    expect(bestPromotionForProduct(makeProduct(), [promo], 1800, AUG_14)).toBeNull();
  });

  it('ignores a promotion that never applies by itself', () => {
    const promo = makePromotion({ autoApply: false });
    expect(bestPromotionForProduct(makeProduct(), [promo], 1800, AUG_14)).toBeNull();
  });

  it('picks the live one over an expired better offer', () => {
    const expired = makePromotion({ id: 'expired', discountValue: 50, endsAt: '2026-08-10T21:00:00Z' });
    const live = makePromotion({ id: 'live', discountValue: 20 });
    expect(bestPromotionForProduct(makeProduct(), [expired, live], 1800, AUG_14)?.id).toBe('live');
  });

  it('still picks the largest discount among live offers', () => {
    const small = makePromotion({ id: 'small', discountValue: 10 });
    const big = makePromotion({ id: 'big', discountValue: 30 });
    expect(bestPromotionForProduct(makeProduct(), [small, big], 1800, AUG_14)?.id).toBe('big');
  });

  it('defaults to the current time when none is given', () => {
    const promo = makePromotion({ endsAt: '2020-01-01T00:00:00Z' });
    expect(bestPromotionForProduct(makeProduct(), [promo], 1800)).toBeNull();
  });
});

describe('lineDiscountCents', () => {
  it('takes nothing off when the only promotion has expired', () => {
    const line: CartLine = { product: makeProduct({ priceCents: 1800 }), quantity: 1 };
    const promo = makePromotion({ endsAt: '2026-08-10T21:00:00Z' });
    expect(lineDiscountCents(line, [promo], AUG_14)).toBe(0);
  });

  it('applies a live promotion to the line gross', () => {
    const line: CartLine = { product: makeProduct({ priceCents: 1800 }), quantity: 2 };
    expect(lineDiscountCents(line, [makePromotion()], AUG_14)).toBe(720);
  });

  it('lets a manual discount win over a live promotion', () => {
    const line: CartLine = {
      product: makeProduct({ priceCents: 1800 }), quantity: 1,
      manualDiscount: { type: 'fixed', value: 500 },
    };
    expect(lineDiscountCents(line, [makePromotion()], AUG_14)).toBe(500);
  });
});

describe('discountAmountCents', () => {
  it('never returns more than the base', () => {
    expect(discountAmountCents(1000, { type: 'fixed', value: 5000 })).toBe(1000);
  });
});
