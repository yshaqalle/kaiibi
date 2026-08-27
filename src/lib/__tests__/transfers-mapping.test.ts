import { listTransferAccounts } from '@/lib/transfers';

// The mapping between list_transfer_accounts() and the transfer picker.
//
// Found by mutation: dropping the `Number()` around `balance_cents` survived a
// full run of the suite. transfer-funds.test.tsx mocks `@/lib/transfers`
// wholesale -- it hands the modal `TransferAccount` objects that are already
// mapped -- so nothing exercised the coercion itself, and it is the one figure
// on that screen a person acts on before any refusal can correct them.
//
// bigint arrives from PostgREST as a STRING. Left as one it still renders as a
// plausible number and still compares, but every comparison is the WRONG kind:
// '90000' < '5000' is true by string order, so a picker sorting or bounding on
// the balance would say the fullest till is the emptiest. formatAccountingCents
// would divide a string by 100 and coerce late, hiding it further.

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

beforeEach(() => mockRpc.mockReset());

describe('the transfer picker mapping', () => {
  it('reads each balance as the number it is, not the string PostgREST sent', async () => {
    mockRpc.mockResolvedValue({
      data: [
        { code: '1000', name: 'Till', balance_cents: '434000' },
        { code: '1010', name: 'Salaam, Hodan branch', balance_cents: '90000' },
      ],
      error: null,
    });
    const accounts = await listTransferAccounts('shop-1');
    expect(accounts).toEqual([
      { code: '1000', name: 'Till', balanceCents: 434000 },
      { code: '1010', name: 'Salaam, Hodan branch', balanceCents: 90000 },
    ]);
    // Stated outright as well as through toEqual, because the TYPE is the
    // property being pinned and a later loosening of the assertion above --
    // toMatchObject, or comparing one field at a time -- would drop it
    // silently.
    expect(typeof accounts[0].balanceCents).toBe('number');
  });

  it('keeps the shop s own name for the account, which is the whole reason this door exists', async () => {
    mockRpc.mockResolvedValue({
      data: [{ code: '1010', name: 'Salaam, Hodan branch', balance_cents: '0' }],
      error: null,
    });
    const [account] = await listTransferAccounts('shop-1');
    expect(account.name).toBe('Salaam, Hodan branch');
    // A real and reachable figure: an emptied till is not a missing one.
    expect(account.balanceCents).toBe(0);
  });

  it('throws whatever the database refused with, so the modal can print it', async () => {
    // The sentence budgets.manage's absence raises. A PostgrestError is a plain
    // object and NEVER `instanceof Error`, which is the shape that made a
    // shipped screen print a line of its own instead of this one.
    const refusal = {
      code: 'P0001',
      details: null,
      hint: null,
      message: 'You do not have permission to move money between accounts.',
    };
    mockRpc.mockResolvedValue({ data: null, error: refusal });
    await expect(listTransferAccounts('shop-1')).rejects.toBe(refusal);
  });

  it('reads an empty answer as no accounts rather than crashing on null', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(listTransferAccounts('shop-1')).resolves.toEqual([]);
  });
});
