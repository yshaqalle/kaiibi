// settings-sidebar.tsx transitively imports src/lib/supabase.ts, which throws
// at import time unless EXPO_PUBLIC_SUPABASE_URL/ANON_KEY are set. This test
// never calls a Supabase method, so a bare mock is enough to let the import
// chain resolve without real credentials -- do not delete this as unused.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import { isSettingsNavId, SETTINGS_NAV } from '@/components/settings/settings-sidebar';

describe('isSettingsNavId', () => {
  it('accepts a real panel id', () => {
    expect(isSettingsNavId('locations')).toBe(true);
  });

  // The guard exists because this value arrives from a URL, where anything
  // can be typed. A bad one must fall back, never render an empty screen.
  it('rejects anything that is not one', () => {
    expect(isSettingsNavId('nonsense')).toBe(false);
    expect(isSettingsNavId(undefined)).toBe(false);
    expect(isSettingsNavId(42)).toBe(false);
  });
});

describe('storefront nav entry', () => {
  const item = SETTINGS_NAV.flatMap((g) => g.items).find((i) => i.id === 'storefront');

  it('exists and is labelled for a shopkeeper', () => {
    expect(item).toBeDefined();
    expect(item!.label).toBe('Storefront');
  });

  it('is gated on the storefront module, so an unentitled shop never sees it', () => {
    expect(item!.module).toBe('storefront');
  });

  it('passes the id guard, which is written out by hand and easy to forget', () => {
    expect(isSettingsNavId('storefront')).toBe(true);
  });
});
