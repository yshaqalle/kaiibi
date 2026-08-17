// What completeSale actually sends. Asserted because the credit flag was added
// to this function's signature, threaded through pos.tsx, and never put into the
// RPC payload -- so "Pay later" was refused by the server with "at least one
// payment is required" while every unit test passed. A parameter that never
// leaves the client is invisible to every test that does not read the wire.

import type { CartLine, PaymentLine, Product } from '@/types/models';

type FakeState = { rpcCalls: [string, any][]; result: { data: unknown; error: unknown } };

jest.mock('@/lib/supabase', () => {
  const state: FakeState = { rpcCalls: [], result: { data: 'sale-1', error: null } };
  return {
    supabase: {
      rpc: async (name: string, params: any) => {
        state.rpcCalls.push([name, params]);
        return state.result;
      },
    },
    __state: state,
  };
});

import { completeSale, editSale } from '@/lib/sales';

const { __state: fake } = jest.requireMock('@/lib/supabase') as { __state: FakeState };

const product = { id: 'p1', name: 'Sugar', priceCents: 1000 } as unknown as Product;
const lines: CartLine[] = [{ product, quantity: 1 }];
const cash: PaymentLine = {
  method: 'cash', amountCents: 1000, tenderedCents: 1000, customerName: null, customerPhone: null,
  currencyCode: null, exchangeRate: null, foreignAmountCents: null, foreignChangeCents: null,
};

beforeEach(() => { fake.rpcCalls.length = 0; });

const sent = () => fake.rpcCalls[0][1];

describe('completeSale', () => {
  it('sends p_allow_balance when the sale is being left part-paid', async () => {
    await completeSale('shop1', lines, [cash], { id: 'c1' }, null, [], 0, null, 0, null, Date.now(), true);
    expect(sent().p_allow_balance).toBe(true);
  });

  it('omits it entirely on an ordinary sale', async () => {
    // The payload for a normal sale stays exactly what it was before credit
    // existed, so a server without migration 20260831000100 keeps taking it.
    await completeSale('shop1', lines, [cash]);
    expect(sent()).not.toHaveProperty('p_allow_balance');
  });

  it('lets a sale through with no payments at all when credit was asked for', async () => {
    // Goods today, money Friday. Refused by the client's own guard until the
    // flag existed.
    await completeSale('shop1', lines, [], { id: 'c1' }, null, [], 0, null, 0, null, Date.now(), true);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(sent().p_payments).toEqual([]);
  });

  it('still refuses an empty payment list on an ordinary sale', async () => {
    await expect(completeSale('shop1', lines, [])).rejects.toThrow('At least one payment is required');
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

// editSale had the same gap completeSale did: a part-paid sale could not be
// edited at all, because the client refused an empty payment list and never sent
// the flag that lets the server accept a shortfall.
describe('editSale', () => {
  const items = [{ productId: 'p1', quantity: 1 }];

  it('sends p_allow_balance when the sale carries a balance', async () => {
    await editSale('s1', items, [cash], { id: 'c1' }, 0, true);
    expect(sent().p_allow_balance).toBe(true);
  });

  it('omits it on an ordinary edit', async () => {
    await editSale('s1', items, [cash]);
    expect(sent()).not.toHaveProperty('p_allow_balance');
  });

  it('edits a wholly unpaid sale, which used to be impossible', async () => {
    await editSale('s1', items, [], { id: 'c1' }, 0, true);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(sent().p_payments).toEqual([]);
  });

  it('still refuses an empty payment list on an ordinary edit', async () => {
    await expect(editSale('s1', items, [])).rejects.toThrow('At least one payment is required');
    expect(fake.rpcCalls).toHaveLength(0);
  });
});
