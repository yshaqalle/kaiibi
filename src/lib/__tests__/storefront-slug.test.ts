import {
  normalizeSlug,
  validateSlug,
  RESERVED_SLUGS,
  deriveSlugFromName,
  applySuffix,
} from '@/lib/storefront-slug';

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

describe('deriveSlugFromName', () => {
  it('normalizes a shop name into a suggested slug', () => {
    expect(deriveSlugFromName('Xamdi Electronics')).toBe('xamdi-electronics');
  });

  it('a name that normalizes to nothing yields no suggestion', () => {
    expect(deriveSlugFromName('!!!')).toBe('');
    expect(deriveSlugFromName('')).toBe('');
  });

  it('truncates an over-long name without landing on a trailing hyphen', () => {
    // Normalizes to 62 x's, a hyphen at index 62, then more characters --
    // slicing at 63 keeps the hyphen as the very last character.
    const name = 'x'.repeat(62) + ' ' + 'y'.repeat(10);
    const result = deriveSlugFromName(name);

    expect(result).toBe('x'.repeat(62));
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result.endsWith('-')).toBe(false);
    expect(validateSlug(result)).toBeNull();
  });

  it('derives a reserved name rather than judging it -- validateSlug does the refusing', () => {
    expect(deriveSlugFromName('Admin')).toBe('admin');
    expect(validateSlug(deriveSlugFromName('Admin'))).toBe('reserved');
  });
});

describe('applySuffix', () => {
  it('joins base and suffix with a single hyphen', () => {
    expect(applySuffix('xamdi-electronics', 'Koodbuur')).toBe('xamdi-electronics-koodbuur');
  });

  it('never produces a double hyphen even if the suffix brings its own', () => {
    expect(applySuffix('xamdi-electronics', '-koodbuur')).toBe('xamdi-electronics-koodbuur');
  });

  it('returns the base unchanged for an empty suffix', () => {
    expect(applySuffix('xamdi-electronics', '')).toBe('xamdi-electronics');
  });

  it('returns the base unchanged for a whitespace-only suffix', () => {
    expect(applySuffix('xamdi-electronics', '   ')).toBe('xamdi-electronics');
  });

  it('does not silently truncate a suffix that would push past 63 characters -- validateSlug refuses it instead', () => {
    const base = 'x'.repeat(60);
    const suffix = 'abcabc';
    const result = applySuffix(base, suffix);

    expect(result).toBe(`${base}-${suffix}`);
    expect(result.length).toBeGreaterThan(63);
    expect(validateSlug(result)).toBe('too_long');
  });
});
