import {
  categoryMeta,
  isSupportCategory,
  needsAreaOther,
  OPERATOR_CATEGORIES,
  OTHER_AREA_KEY,
  SUPPORT_CATEGORIES,
  type SupportCategory,
} from '@/lib/support-taxonomy';

describe('SUPPORT_CATEGORIES', () => {
  it('offers the eight categories the store picks from', () => {
    expect(SUPPORT_CATEGORIES.map((c) => c.key)).toEqual([
      'broken', 'help', 'billing', 'access', 'data', 'hardware', 'feature', 'other',
    ]);
  });

  // Every one of these drives visible copy. A blank label ships an empty chip,
  // and a blank prompt is the whole reason the second field exists.
  it('gives every category a label, a details label and a hint', () => {
    for (const category of SUPPORT_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
      expect(category.shortLabel.length).toBeGreaterThan(0);
      expect(category.detailsLabel.length).toBeGreaterThan(0);
      expect(category.detailsHint.length).toBeGreaterThan(0);
      expect(category.glyph.length).toBeGreaterThan(0);
    }
  });

  // The capture mechanism only works if there is always something to capture
  // from -- a dropdown with no escape hatch silently loses the answers that
  // would have told us the list is wrong.
  it('ends every non-empty area list with the "other" escape hatch', () => {
    for (const category of SUPPORT_CATEGORIES) {
      if (category.areas.length === 0) {
        expect(category.areaLabel).toBeNull();
        continue;
      }
      expect(category.areaLabel).not.toBeNull();
      expect(category.areas[category.areas.length - 1].key).toBe(OTHER_AREA_KEY);
    }
  });

  it('gives "other" no dropdown of its own', () => {
    expect(categoryMeta('other').areas).toEqual([]);
    expect(categoryMeta('other').areaLabel).toBeNull();
  });

  it('has unique area keys within each category', () => {
    for (const category of SUPPORT_CATEGORIES) {
      const keys = category.areas.map((a) => a.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('categoryMeta', () => {
  it('finds each category by key', () => {
    expect(categoryMeta('billing').label).toBe('Billing or payment');
    expect(categoryMeta('broken').detailsLabel).toBe('What happened?');
  });

  it('throws on an unknown key rather than returning undefined', () => {
    expect(() => categoryMeta('nope' as SupportCategory)).toThrow(/unknown support category/i);
  });
});

describe('isSupportCategory', () => {
  it('accepts every real key and rejects anything else', () => {
    for (const category of SUPPORT_CATEGORIES) {
      expect(isSupportCategory(category.key)).toBe(true);
    }
    expect(isSupportCategory('urgent')).toBe(false);
    expect(isSupportCategory(null)).toBe(false);
    expect(isSupportCategory(3)).toBe(false);
  });
});

describe('needsAreaOther', () => {
  it('asks for free text when the picked area is the escape hatch', () => {
    expect(needsAreaOther('broken', OTHER_AREA_KEY)).toBe(true);
  });

  it('asks for free text whenever the category itself is "other"', () => {
    expect(needsAreaOther('other', null)).toBe(true);
  });

  it('does not ask otherwise', () => {
    expect(needsAreaOther('broken', 'pos')).toBe(false);
    expect(needsAreaOther('broken', null)).toBe(false);
  });
});

describe('OPERATOR_CATEGORIES', () => {
  // Deliberately shorter than the store's: an operator never files a feature
  // request or a hardware fault against a customer.
  it('is the shorter operator-side list', () => {
    expect(OPERATOR_CATEGORIES.map((c) => c.key)).toEqual([
      'billing', 'account', 'problem', 'changed', 'other',
    ]);
  });
});
