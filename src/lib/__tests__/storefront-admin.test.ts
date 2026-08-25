jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import { publishBlockers } from '@/lib/storefront-admin';

describe('publishBlockers', () => {
  it('lets a complete shop publish', () => {
    expect(publishBlockers({ slug: 'xamdi', whatsappE164: '+252634456789', onlineProductCount: 3 })).toEqual([]);
  });

  it('blocks without a slug', () => {
    expect(publishBlockers({ slug: null, whatsappE164: '+252634456789', onlineProductCount: 3 })).toContain('no_slug');
  });

  it('blocks without a WhatsApp number, because every button on the page opens that chat', () => {
    expect(publishBlockers({ slug: 'xamdi', whatsappE164: null, onlineProductCount: 3 })).toContain('no_whatsapp');
  });

  it('blocks with nothing listed, because an empty page helps nobody', () => {
    expect(publishBlockers({ slug: 'xamdi', whatsappE164: '+252634456789', onlineProductCount: 0 })).toContain('no_products');
  });

  it('reports every blocker at once rather than one at a time', () => {
    const blockers = publishBlockers({ slug: null, whatsappE164: null, onlineProductCount: 0 });
    expect(blockers).toEqual(expect.arrayContaining(['no_slug', 'no_whatsapp', 'no_products']));
    expect(blockers).toHaveLength(3);
  });
});
