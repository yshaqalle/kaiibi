import { isLocale, resolveInitialLocale, translate, LOCALES } from '@/lib/i18n';
import { en } from '@/lib/i18n/messages.en';
import { so } from '@/lib/i18n/messages.so';

describe('resolveInitialLocale', () => {
  it('prefers a saved choice over the device, in both directions', () => {
    // Someone who picked English on a Somali phone meant it, and vice versa.
    expect(resolveInitialLocale('so', 'en-US')).toBe('so');
    expect(resolveInitialLocale('en', 'so-SO')).toBe('en');
  });

  it('falls back to the device language when nothing is saved', () => {
    expect(resolveInitialLocale(null, 'so')).toBe('so');
    expect(resolveInitialLocale(null, 'so-SO')).toBe('so');
    expect(resolveInitialLocale(null, 'so-DJ')).toBe('so');
    expect(resolveInitialLocale(null, 'en-GB')).toBe('en');
  });

  it('matches the whole primary subtag, not a prefix', () => {
    // `son-ML` is Songhai. A startsWith('so') check -- which is what the
    // design mock-up's own script did -- hands those users Somali.
    expect(resolveInitialLocale(null, 'son-ML')).toBe('en');
    expect(resolveInitialLocale(null, 'sog')).toBe('en');
  });

  it('accepts an underscore-separated tag', () => {
    // Some platforms report `so_SO` rather than `so-SO`.
    expect(resolveInitialLocale(null, 'so_SO')).toBe('so');
  });

  it('is case-insensitive about the device tag', () => {
    expect(resolveInitialLocale(null, 'SO-so')).toBe('so');
  });

  it('defaults to English with nothing to go on', () => {
    expect(resolveInitialLocale(null, null)).toBe('en');
    expect(resolveInitialLocale(null, '')).toBe('en');
  });

  it('ignores an unrecognised saved value and falls through to the device', () => {
    // A stale or hand-edited storage entry must not pin the app to a locale
    // that no longer exists.
    expect(resolveInitialLocale('fr', 'so')).toBe('so');
    expect(resolveInitialLocale('', 'so')).toBe('so');
  });
});

describe('isLocale', () => {
  it('accepts exactly the supported locales', () => {
    expect(LOCALES.every(isLocale)).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(2)).toBe(false);
  });
});

describe('message tables', () => {
  // Types already make a MISSING key impossible (messages.so.ts is annotated
  // `: Messages`). This catches what types cannot: a key left as an empty
  // string mid-translation, which would render as a blank on screen.
  it('agree on their key sets', () => {
    expect(Object.keys(so).sort()).toEqual(Object.keys(en).sort());
  });

  it('have no empty values', () => {
    expect(Object.entries(en).filter(([, v]) => v.trim() === '')).toEqual([]);
    expect(Object.entries(so).filter(([, v]) => v.trim() === '')).toEqual([]);
  });

  it('keep every {placeholder} across both languages', () => {
    // A translated string that drops `{year}` silently loses the value.
    const tokens = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect({ key, tokens: tokens(so[key]) }).toEqual({ key, tokens: tokens(en[key]) });
    }
  });
});

describe('translate', () => {
  it('returns the string for the active locale', () => {
    expect(translate('en', 'nav.signIn')).toBe('Sign in');
    expect(translate('so', 'nav.signIn')).toBe('Gal');
  });

  it('fills placeholders', () => {
    expect(translate('en', 'footer.copyright', { year: 2026 })).toBe(
      '© 2026 Kaiibi. All rights reserved.'
    );
    expect(translate('so', 'footer.copyright', { year: 2026 })).toContain('2026');
  });

  it('leaves an unmatched token as written rather than blanking it', () => {
    // A visible `{year}` is a bug report; an empty gap looks like a missing
    // translation and gets ignored.
    expect(translate('en', 'footer.copyright')).toContain('{year}');
    expect(translate('en', 'footer.copyright', { other: 1 })).toContain('{year}');
  });
});
