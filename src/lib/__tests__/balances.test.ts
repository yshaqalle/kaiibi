// A settlement is one payment against a customer who may owe on three sales.
// Which sale it pays down is the only real decision the client makes here, and
// getting it wrong means the oldest debt sits there forever while newer ones
// clear -- so `allocate` carries most of these tests.

import { allocate, customerBalance, listOutstanding, settleBalance, type CustomerBalance } from '@/lib/balances';
import type { PaymentLine } from '@/types/models';

type FakeState = {
  rows: any[];
  error: unknown;
  eqs: string[][];
  orders: [string, unknown][];
  rpcCalls: [string, any][];
  rpcResult: { data: unknown; error: unknown };
};

// Hoisted above the imports by babel-plugin-jest-hoist, so balances.ts picks up
// this client rather than the real one. The factory references nothing outside
// itself -- it runs before any module-scope binding exists -- and hands its
// state back through the module, the way csv-import-roundtrip.test.ts does.
jest.mock('@/lib/supabase', () => {
  const state: FakeState = { rows: [], error: null, eqs: [], orders: [], rpcCalls: [], rpcResult: { data: null, error: null } };
  const client = {
    rpc: async (name: string, params: any) => {
      state.rpcCalls.push([name, params]);
      return state.rpcResult;
    },
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: (column: string, value: string) => {
          state.eqs.push([table, column, value]);
          return chain;
        },
        // The queries under test all end in .order(), which is where the
        // builder becomes a promise.
        order: (column: string, opts: unknown) => {
          state.orders.push([column, opts]);
          return Promise.resolve({ data: state.rows, error: state.error });
        },
      };
      return chain;
    },
  };
  return { supabase: client, __state: state };
});

const { __state: fake } = jest.requireMock('@/lib/supabase') as { __state: FakeState };

const owed = (saleId: string, owedCents: number, saleCreatedAt: string): CustomerBalance => ({
  customerId: 'c1',
  customerName: 'Farah Hassan',
  saleId,
  saleCreatedAt,
  totalCents: owedCents,
  paidCents: 0,
  refundedCents: 0,
  owedCents,
});

const cash = (amountCents: number): PaymentLine => ({
  method: 'cash',
  amountCents,
  tenderedCents: null,
  customerName: null,
  customerPhone: null,
  currencyCode: null,
  exchangeRate: null,
  foreignAmountCents: null,
  foreignChangeCents: null,
});

beforeEach(() => {
  fake.rows = [];
  fake.error = null;
  fake.eqs.length = 0;
  fake.orders.length = 0;
  fake.rpcCalls.length = 0;
  fake.rpcResult = { data: null, error: null };
});

describe('allocate', () => {
  it('pays the oldest debt first', () => {
    const result = allocate([cash(1000)], [
      owed('new', 5000, '2026-08-14T10:00:00.000Z'),
      owed('old', 3474, '2026-08-12T10:00:00.000Z'),
    ]);
    expect(result).toEqual([{ saleId: 'old', payments: [cash(1000)] }]);
  });

  it('spills onto the next sale once one is cleared', () => {
    const result = allocate([cash(4000)], [
      owed('old', 3474, '2026-08-12T10:00:00.000Z'),
      owed('new', 5000, '2026-08-14T10:00:00.000Z'),
    ]);
    expect(result).toEqual([
      { saleId: 'old', payments: [cash(3474)] },
      { saleId: 'new', payments: [cash(526)] },
    ]);
  });

  it('takes nothing when nothing is owed', () => {
    expect(allocate([cash(1000)], [])).toEqual([]);
  });

  it('never allocates more than was handed over', () => {
    const result = allocate([cash(1000)], [owed('old', 3474, '2026-08-12T10:00:00.000Z')]);
    expect(result[0].payments[0].amountCents).toBe(1000);
  });

  it('never allocates more than a sale owes', () => {
    const result = allocate([cash(9999)], [owed('old', 3474, '2026-08-12T10:00:00.000Z')]);
    expect(result).toHaveLength(1);
    expect(result[0].payments[0].amountCents).toBe(3474);
  });

  it('carries several payment methods onto the same debt', () => {
    const zaad: PaymentLine = { ...cash(500), method: 'zaad' };
    const result = allocate([cash(1000), zaad], [owed('old', 3474, '2026-08-12T10:00:00.000Z')]);
    expect(result).toEqual([{ saleId: 'old', payments: [cash(1000), zaad] }]);
  });

  it('drops the tender off a payment that was split across two sales', () => {
    // $40 handed over, $34.74 of it applied to one sale: recording 4000
    // tendered against it would imply 526 in change that nobody was given --
    // the rest went to the other sale. The tender describes the transaction,
    // not either sale's share of it.
    const forty: PaymentLine = { ...cash(4000), tenderedCents: 5000, foreignAmountCents: 460000, foreignChangeCents: 115000 };
    const result = allocate([forty], [
      owed('old', 3474, '2026-08-12T10:00:00.000Z'),
      owed('new', 5000, '2026-08-14T10:00:00.000Z'),
    ]);
    expect(result[0].payments[0].tenderedCents).toBeNull();
    expect(result[0].payments[0].foreignAmountCents).toBeNull();
    expect(result[1].payments[0].tenderedCents).toBeNull();
  });

  it('keeps the tender when the payment lands wholly on one sale', () => {
    const forty: PaymentLine = { ...cash(3474), tenderedCents: 4000 };
    const result = allocate([forty], [owed('old', 3474, '2026-08-12T10:00:00.000Z')]);
    expect(result[0].payments[0].tenderedCents).toBe(4000);
  });

  it('skips a sale that owes nothing rather than emitting a zero payment', () => {
    const result = allocate([cash(1000)], [
      owed('settled', 0, '2026-08-10T10:00:00.000Z'),
      owed('old', 3474, '2026-08-12T10:00:00.000Z'),
    ]);
    expect(result).toEqual([{ saleId: 'old', payments: [cash(1000)] }]);
  });

  it('orders two sales rung up in the same instant by id, so it never varies', () => {
    // Two sales can share a timestamp. Without a tiebreak the order is whatever
    // the query happened to return, and the same settlement pays down a
    // different sale each time it is retried.
    const same = '2026-08-12T10:00:00.000Z';
    const forwards = allocate([cash(9999)], [owed('bbb', 1000, same), owed('aaa', 1000, same)]);
    const backwards = allocate([cash(9999)], [owed('aaa', 1000, same), owed('bbb', 1000, same)]);
    expect(forwards.map((a) => a.saleId)).toEqual(['aaa', 'bbb']);
    expect(backwards.map((a) => a.saleId)).toEqual(['aaa', 'bbb']);
  });
});

describe('settleBalance', () => {
  it('sends the payload the RPC reads, and returns what is still owed', async () => {
    fake.rpcResult = { data: 1200, error: null };
    const left = await settleBalance('s1', [{ ...cash(800), method: 'zaad' }], 'sess1');
    expect(left).toBe(1200);
    expect(fake.rpcCalls).toEqual([['settle_sale_balance', {
      p_sale_id: 's1',
      p_payments: [
        {
          method: 'zaad',
          amount_cents: 800,
          tendered_cents: null,
          customer_name: null,
          customer_phone: null,
          currency_code: null,
          exchange_rate: null,
          foreign_amount_cents: null,
          foreign_change_cents: null,
        },
      ],
      p_register_session_id: 'sess1',
    }]]);
  });

  it('omits the session rather than sending null, like completeSale does', async () => {
    fake.rpcResult = { data: 0, error: null };
    await settleBalance('s1', [cash(100)], null);
    expect(fake.rpcCalls[0][1]).not.toHaveProperty('p_register_session_id');
  });

  it('throws the server refusal rather than swallowing it', async () => {
    fake.rpcResult = { data: null, error: { message: 'this sale is already paid in full' } };
    await expect(settleBalance('s1', [cash(100)], null)).rejects.toEqual({
      message: 'this sale is already paid in full',
    });
  });

  it('refuses to call the server with no payments', async () => {
    await expect(settleBalance('s1', [], null)).rejects.toThrow('At least one payment is required');
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

describe('customerBalance', () => {
  it('totals what one customer owes and names the oldest sale', async () => {
    fake.rows = [
      { customer_id: 'c1', customer_name: 'Farah Hassan', sale_id: 'old', sale_created_at: '2026-08-12T10:00:00.000Z',
        total_cents: 3474, paid_cents: 0, refunded_cents: 0, owed_cents: 3474 },
      { customer_id: 'c1', customer_name: 'Farah Hassan', sale_id: 'new', sale_created_at: '2026-08-14T10:00:00.000Z',
        total_cents: 5000, paid_cents: 1000, refunded_cents: 0, owed_cents: 4000 },
    ];
    const result = await customerBalance('shop1', 'c1');
    expect(result.owedCents).toBe(7474);
    expect(result.oldest?.saleId).toBe('old');
    expect(result.sales).toHaveLength(2);
    expect(fake.eqs).toEqual([
      ['customer_balances', 'shop_id', 'shop1'],
      ['customer_balances', 'customer_id', 'c1'],
    ]);
    expect(fake.orders).toEqual([['sale_created_at', { ascending: true }]]);
  });

  it('reads a customer who owes nothing as zero, not as an error', async () => {
    fake.rows = [];
    const result = await customerBalance('shop1', 'c1');
    expect(result).toEqual({ owedCents: 0, oldest: null, sales: [] });
  });

  it('throws when the query fails, so a screen never shows 0 owed on a broken read', async () => {
    fake.error = { message: 'permission denied' };
    await expect(customerBalance('shop1', 'c1')).rejects.toEqual({ message: 'permission denied' });
  });
});

describe('listOutstanding', () => {
  it('reads every unsettled sale in the shop, oldest first', async () => {
    fake.rows = [
      { customer_id: 'c1', customer_name: 'Farah Hassan', sale_id: 'old', sale_created_at: '2026-08-12T10:00:00.000Z',
        total_cents: 3474, paid_cents: 0, refunded_cents: 0, owed_cents: 3474 },
    ];
    const rows = await listOutstanding('shop1');
    expect(rows).toEqual([
      {
        customerId: 'c1',
        customerName: 'Farah Hassan',
        saleId: 'old',
        saleCreatedAt: '2026-08-12T10:00:00.000Z',
        totalCents: 3474,
        paidCents: 0,
        refundedCents: 0,
        owedCents: 3474,
      },
    ]);
    expect(fake.eqs).toEqual([['customer_balances', 'shop_id', 'shop1']]);
  });
});
