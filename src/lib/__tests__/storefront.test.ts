// storefront.ts imports '@/lib/supabase', which constructs the real client at
// module load and throws without EXPO_PUBLIC_SUPABASE_* env vars -- same
// reason billing-period.test.ts mocks this module. waLink itself never
// touches Supabase; this only unblocks the import.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import { waLink } from '@/lib/storefront';

describe('waLink', () => {
  it('drops the plus, because wa.me takes bare digits', () => {
    expect(waLink('+252634456789', 'hello')).toBe('https://wa.me/252634456789?text=hello');
  });

  it('encodes the message', () => {
    expect(waLink('+252634456789', 'Anker 20W charger — $12')).toBe(
      'https://wa.me/252634456789?text=Anker%2020W%20charger%20%E2%80%94%20%2412',
    );
  });

  it('handles a newline, which a multi-line order message needs', () => {
    expect(waLink('+252634456789', 'a\nb')).toBe('https://wa.me/252634456789?text=a%0Ab');
  });
});
