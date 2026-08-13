import { posterCopyFor } from '@/lib/poster';
import type { Promotion } from '@/types/models';

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 'p1', shopId: 's1', locationId: null, name: 'Eid weekend',
    discountType: 'percentage', discountValue: 20, scope: 'store', scopeValue: null,
    active: true, startsAt: null, endsAt: null, autoApply: true, archivedAt: null,
    createdAt: '', ...overrides,
  };
}

const BASE = { shopName: 'Suuqa Xamar', branch: null, address: null, hours: null, phone: null, headline: null };

describe('posterCopyFor', () => {
  it('prints a percentage as a percentage', () => {
    expect(posterCopyFor({ ...BASE, promotion: makePromotion() }).value).toBe('20%');
  });

  it('prints a fixed discount as money', () => {
    const promo = makePromotion({ discountType: 'fixed', discountValue: 250 });
    expect(posterCopyFor({ ...BASE, promotion: promo }).value).toBe('$2.50');
  });

  it('says what a store-wide offer applies to', () => {
    expect(posterCopyFor({ ...BASE, promotion: makePromotion() }).scope).toBe('Everything in store');
  });

  it('names the category a category offer applies to', () => {
    const promo = makePromotion({ scope: 'category', scopeValue: 'Shoes' });
    expect(posterCopyFor({ ...BASE, promotion: promo }).scope).toBe('All Shoes');
  });

  it('names the brand a brand offer applies to', () => {
    const promo = makePromotion({ scope: 'brand', scopeValue: 'Somtel' });
    expect(posterCopyFor({ ...BASE, promotion: promo }).scope).toBe('Anything by Somtel');
  });

  it('prints no date line at all when the offer has no window', () => {
    expect(posterCopyFor({ ...BASE, promotion: makePromotion() }).when).toBeNull();
  });

  it('prints an end-only window as "until" the inclusive last day', () => {
    // Stored exclusive (the instant it stops), shown inclusive -- see
    // src/lib/promotion-dates.ts. An offer stored as ending at midnight on the
    // 17th ran through the 16th, and that is what a customer must read.
    const promo = makePromotion({ endsAt: new Date(2026, 7, 17).toISOString() });
    expect(posterCopyFor({ ...BASE, promotion: promo }).when).toBe('Until Sunday 16 August');
  });

  it('prints a closed window as a range', () => {
    const promo = makePromotion({
      startsAt: new Date(2026, 7, 14).toISOString(),
      endsAt: new Date(2026, 7, 17).toISOString(),
    });
    expect(posterCopyFor({ ...BASE, promotion: promo }).when).toBe('Friday 14 — Sunday 16 August');
  });

  it('prints a start-only window as "from"', () => {
    const promo = makePromotion({ startsAt: new Date(2026, 7, 14).toISOString() });
    expect(posterCopyFor({ ...BASE, promotion: promo }).when).toBe('From Friday 14 August');
  });

  it('carries the shop and branch details through untouched', () => {
    const copy = posterCopyFor({
      ...BASE, promotion: makePromotion(), branch: 'Xamar branch',
      address: 'Sooq Bakaaro', hours: '08:00 – 21:00', phone: '063 442 1180',
    });
    expect(copy.shopName).toBe('Suuqa Xamar');
    expect(copy.branch).toBe('Xamar branch');
    expect(copy.address).toBe('Sooq Bakaaro');
    expect(copy.hours).toBe('08:00 – 21:00');
    expect(copy.phone).toBe('063 442 1180');
  });

  it('keeps a headline the owner wrote, and trims it', () => {
    const copy = posterCopyFor({ ...BASE, promotion: makePromotion(), headline: '  Ciid wanaagsan  ' });
    expect(copy.headline).toBe('Ciid wanaagsan');
  });

  it('treats a blank headline as none', () => {
    expect(posterCopyFor({ ...BASE, promotion: makePromotion(), headline: '   ' }).headline).toBeNull();
  });
});
