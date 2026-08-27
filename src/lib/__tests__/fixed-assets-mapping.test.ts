import { getFixedAssetSummary, listFixedAssets } from '@/lib/fixed-assets';
import { updateShop } from '@/lib/shops';

// The two coercions between PostgREST and the screens, which have no other test.
//
// Found by mutation: both survived a full run of the suite. The screen tests
// mock these modules wholesale, so nothing was exercising the mapping itself --
// and each of these is a one-character change that turns a correct database
// answer into a confident wrong one on screen.
//
//   * `net_book_cents` arrives NULL for a disposed asset, and null means "this
//     is off the balance sheet" rather than "this is worth nothing". A bare
//     Number() coercion makes it 0, which renders as $0.00 in the Book value
//     column of a row describing something the shop sold.
//   * `auto_close_periods` falls back when the column is missing -- a shop row
//     fetched before 20261003000100 reaches a database. The fallback must be
//     'ask', which is the default AFTER 20261005000200 moved it there. Falling
//     back to 'automatic' would put a shop into the one mode nobody may end up
//     in by accident: it wakes phase 2b's sixty-six redate branches, none of
//     which has ever fired for a real shop.
//
// bigint arrives as a STRING over PostgREST, which is why every money field
// below is given as one: a bare `+` on it concatenates rather than adds.

const mockRpc = jest.fn();
const mockSingle = jest.fn();
// The COLUMN PAYLOAD updateShop actually sends. Captured rather than assumed:
// a spread guarded by the wrong condition drops a column silently, and a test
// that only reads the row coming BACK passes for a write that never happened --
// which is precisely how auto_close_periods came to be unwritable.
const mockUpdatePayload = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      update: (payload: unknown) => {
        mockUpdatePayload(payload);
        return {
          eq: () => ({
            select: () => ({ single: () => mockSingle() }),
          }),
        };
      },
    }),
  },
}));

beforeEach(() => {
  mockRpc.mockReset();
  mockSingle.mockReset();
  mockUpdatePayload.mockReset();
});

describe('the register mapping', () => {
  it('keeps a disposed asset s book value NULL rather than coercing it to zero', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          id: 'fa-1',
          name: 'Printer',
          account_code: '1500',
          account_name: 'Equipment',
          acquired_on: '2026-01-20',
          life_months: 10,
          cost_cents: '5000',
          accumulated_cents: '2000',
          net_book_cents: null,
          months_charged: 4,
          disposed_on: '2026-05-10',
          disposal_proceeds_cents: '2000',
          acquisition_status: 'posted',
        },
      ],
      error: null,
    });
    const [row] = await listFixedAssets('shop-1');
    expect(row.netBookCents).toBeNull();
    // ...while the two figures that ARE facts about a sold asset survive as
    // numbers rather than the strings they arrived as.
    expect(row.costCents).toBe(5000);
    expect(row.accumulatedCents).toBe(2000);
    expect(row.disposalProceedsCents).toBe(2000);
  });

  it('reads a live asset s book value as the number it is', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          id: 'fa-2',
          name: 'Chest freezer',
          account_code: '1500',
          account_name: 'Equipment',
          acquired_on: '2026-01-05',
          life_months: 12,
          cost_cents: '24000',
          accumulated_cents: '8000',
          net_book_cents: '16000',
          months_charged: 4,
          disposed_on: null,
          disposal_proceeds_cents: null,
          acquisition_status: 'reversed',
        },
      ],
      error: null,
    });
    const [row] = await listFixedAssets('shop-1');
    expect(row.netBookCents).toBe(16000);
    expect(row.disposalProceedsCents).toBeNull();
    // Carried through rather than folded into a boolean: 'reversed' and 'none'
    // are different facts and the screen branches on neither being 'posted'.
    expect(row.acquisitionStatus).toBe('reversed');
  });

  it('throws whatever the database refused with, so the screen can print it', async () => {
    const refusal = { code: 'P0001', details: null, hint: null, message: 'You do not have permission to see the books.' };
    mockRpc.mockResolvedValue({ data: null, error: refusal });
    await expect(listFixedAssets('shop-1')).rejects.toBe(refusal);
  });

  it('reads the summary out of the single row a returns-table function sends back', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          live_count: 2,
          disposed_count: 1,
          cost_cents: '25000',
          accumulated_cents: '9000',
          net_book_cents: '16000',
          voided_count: 1,
          voided_cost_cents: '1000',
          last_charge_month: '2026-04-01',
          last_charge_cents: '2834',
        },
      ],
      error: null,
    });
    const summary = await getFixedAssetSummary('shop-1');
    expect(summary).toEqual({
      liveCount: 2,
      disposedCount: 1,
      costCents: 25000,
      accumulatedCents: 9000,
      netBookCents: 16000,
      voidedCount: 1,
      voidedCostCents: 1000,
      lastChargeMonth: '2026-04-01',
      lastChargeCents: 2834,
    });
  });

  it('reports no charge month at all rather than inventing one for a shop that never ran it', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          live_count: 0,
          disposed_count: 0,
          cost_cents: '0',
          accumulated_cents: '0',
          net_book_cents: '0',
          voided_count: 0,
          voided_cost_cents: '0',
          last_charge_month: null,
          last_charge_cents: null,
        },
      ],
      error: null,
    });
    const summary = await getFixedAssetSummary('shop-1');
    expect(summary.lastChargeMonth).toBeNull();
    expect(summary.lastChargeCents).toBe(0);
  });
});

describe('the close-settings mapping', () => {
  it('sends both columns under the names the database gave them', async () => {
    mockSingle.mockResolvedValue({ data: { id: 'shop-1', auto_close_periods: 'automatic', period_close_grace_days: 15 }, error: null });
    const shop = await updateShop('shop-1', { autoClosePeriods: 'automatic', periodCloseGraceDays: 15 });
    // What went TO the database, in its own column names.
    expect(mockUpdatePayload).toHaveBeenCalledWith({
      auto_close_periods: 'automatic',
      period_close_grace_days: 15,
    });
    // ...and what came back, in the app's.
    expect(shop.autoClosePeriods).toBe('automatic');
    expect(shop.periodCloseGraceDays).toBe(15);
  });

  it('sends neither column when neither was asked for, so an unrelated save leaves them alone', async () => {
    mockSingle.mockResolvedValue({ data: { id: 'shop-1', auto_close_periods: 'ask', period_close_grace_days: 10 }, error: null });
    await updateShop('shop-1', { name: 'Anything' });
    expect(mockUpdatePayload).toHaveBeenCalledWith({ name: 'Anything' });
  });

  it('falls back to ask, never to automatic, when the columns are not there yet', async () => {
    // A shop row read before 20261003000100 reaches this database. 'automatic'
    // is the one value a shop must never arrive at without choosing it.
    mockSingle.mockResolvedValue({ data: { id: 'shop-1' }, error: null });
    const shop = await updateShop('shop-1', { name: 'Anything' });
    expect(shop.autoClosePeriods).toBe('ask');
    expect(shop.periodCloseGraceDays).toBe(10);
  });
});
