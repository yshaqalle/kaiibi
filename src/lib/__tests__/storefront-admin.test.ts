type FakeState = {
  rpcCalls: [string, unknown][];
  rpcResult: { data: unknown; error: unknown };
  updateCalls: { table: string; payload: unknown }[];
  updateResult: { error: unknown };
  eqCalls: [string, unknown][];
};

// Hoisted above the imports by babel-plugin-jest-hoist -- storefront-admin.ts
// picks up this client rather than the real one, the same shape as
// balances.test.ts's fake. saveDraft and publishDraft both go through
// supabase.rpc; discardDraft is a plain literal update, so `from().update().eq()`
// needs a chain too.
jest.mock('@/lib/supabase', () => {
  const state: FakeState = {
    rpcCalls: [],
    rpcResult: { data: null, error: null },
    updateCalls: [],
    updateResult: { error: null },
    eqCalls: [],
  };
  const client = {
    rpc: async (name: string, params: unknown) => {
      state.rpcCalls.push([name, params]);
      return state.rpcResult;
    },
    from: (table: string) => ({
      update: (payload: unknown) => {
        state.updateCalls.push({ table, payload });
        return {
          eq: (column: string, value: unknown) => {
            state.eqCalls.push([column, value]);
            return Promise.resolve(state.updateResult);
          },
        };
      },
    }),
  };
  return { supabase: client, __state: state };
});

const { __state: fake } = jest.requireMock('@/lib/supabase') as { __state: FakeState };

import { discardDraft, publishBlockers, publishDraft, saveDraft } from '@/lib/storefront-admin';

beforeEach(() => {
  fake.rpcCalls.length = 0;
  fake.rpcResult = { data: null, error: null };
  fake.updateCalls.length = 0;
  fake.updateResult = { error: null };
  fake.eqCalls.length = 0;
});

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

// The DB-side merge itself (editing the headline, then the about text, must
// not clobber the headline) is proved against a real database in
// verify-storefront-editor.sql -- save_storefront_draft is `draft =
// coalesce(draft, '{}') || p_patch`, which no sequence of client-side calls
// can race. What belongs here is only that this function is a thin,
// faithful wrapper around that RPC: the right name, the right shape, and the
// RPC's own error surfacing rather than a swallowed one.
describe('saveDraft', () => {
  it('sends the patch to save_storefront_draft for the DB to merge', async () => {
    await saveDraft('shop-1', { headline: 'New headline' });
    expect(fake.rpcCalls).toEqual([['save_storefront_draft', { p_shop_id: 'shop-1', p_patch: { headline: 'New headline' } }]]);
  });

  it('throws the RPC error rather than swallowing it', async () => {
    fake.rpcResult = { data: null, error: { message: 'boom' } };
    await expect(saveDraft('shop-1', { headline: 'x' })).rejects.toEqual({ message: 'boom' });
  });
});

describe('publishDraft', () => {
  it('calls the atomic publish_storefront RPC for the shop', async () => {
    await publishDraft('shop-1');
    expect(fake.rpcCalls).toEqual([['publish_storefront', { p_shop_id: 'shop-1' }]]);
  });

  it('throws the RPC error rather than swallowing it', async () => {
    fake.rpcResult = { data: null, error: { message: 'not authorized for shop shop-1' } };
    await expect(publishDraft('shop-1')).rejects.toEqual({ message: 'not authorized for shop shop-1' });
  });
});

// Property 7: discarding a draft is possible and returns the editor to the
// live page. There is nothing to merge away -- unlike saveDraft, a discard
// replaces the whole column with null, so a plain literal update is correct
// and no RPC is needed.
describe('discardDraft', () => {
  it('clears the draft column directly', async () => {
    await discardDraft('shop-1');
    expect(fake.updateCalls).toEqual([{ table: 'storefronts', payload: { draft: null } }]);
    expect(fake.eqCalls).toEqual([['shop_id', 'shop-1']]);
  });

  it('throws on failure rather than swallowing it', async () => {
    fake.updateResult = { error: { message: 'boom' } };
    await expect(discardDraft('shop-1')).rejects.toEqual({ message: 'boom' });
  });
});
