import { normalizeSlug, validateSlug, RESERVED_SLUGS } from '@/lib/storefront-slug';

describe('normalizeSlug', () => {
  it('lowercases and trims', () => {
    expect(normalizeSlug('  Xamdi  ')).toBe('xamdi');
  });

  it('turns spaces and underscores into single hyphens', () => {
    expect(normalizeSlug('Xamdi   Electronics_Shop')).toBe('xamdi-electronics-shop');
  });

  it('drops characters DNS will not carry', () => {
    expect(normalizeSlug("Xamdi's Café!")).toBe('xamdis-caf');
  });

  it('collapses runs of hyphens and strips them from the ends', () => {
    expect(normalizeSlug('--xamdi---shop--')).toBe('xamdi-shop');
  });
});

describe('validateSlug', () => {
  it('accepts an ordinary slug', () => {
    expect(validateSlug('xamdi-electronics')).toBeNull();
  });

  it('rejects one shorter than three characters', () => {
    expect(validateSlug('xa')).toBe('too_short');
  });

  it('rejects one longer than sixty-three, the DNS label limit', () => {
    expect(validateSlug('a'.repeat(64))).toBe('too_long');
  });

  it('rejects uppercase and punctuation rather than silently fixing it', () => {
    expect(validateSlug('Xamdi')).toBe('bad_characters');
    expect(validateSlug('xamdi.shop')).toBe('bad_characters');
  });

  it('rejects a leading or trailing hyphen', () => {
    expect(validateSlug('-xamdi')).toBe('edge_hyphen');
    expect(validateSlug('xamdi-')).toBe('edge_hyphen');
  });

  it('rejects every reserved name', () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(validateSlug(reserved)).toBe('reserved');
    }
  });

  it('reserves the names the app itself answers on', () => {
    expect(RESERVED_SLUGS).toEqual(expect.arrayContaining(['www', 'app', 'api', 'admin', 'platform']));
  });
});
