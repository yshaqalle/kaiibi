import { listShopPeople } from '@/lib/platform';

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => mockRpc(...args) } }));

beforeEach(() => mockRpc.mockReset());

const row = (over: Record<string, unknown>) => ({
  shop_id: 'shop-1',
  user_id: 'u1',
  full_name: 'Sahra Ismaaciil',
  email: 'sahra@hooyo.so',
  phone: '0634418820',
  role_name: 'Cashier',
  role_permissions: ['sales.record'],
  is_owner: false,
  active: true,
  joined_at: '2026-08-03T09:00:00Z',
  branch_names: ['Koodbuur'],
  ...over,
});

describe('listShopPeople', () => {
  it('asks for exactly the shops it was given', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await listShopPeople(['shop-1', 'shop-2']);
    expect(mockRpc).toHaveBeenCalledWith('platform_shop_people', { p_shop_ids: ['shop-1', 'shop-2'] });
  });

  // One call for the whole console, not one per drawer. A per-store fetch
  // would be N+1 against the busiest screen in the portal.
  it('does not call the database at all for an empty list', async () => {
    const people = await listShopPeople([]);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(people.size).toBe(0);
  });

  it('groups people by shop and maps every column', async () => {
    mockRpc.mockResolvedValue({
      data: [row({}), row({ shop_id: 'shop-2', user_id: 'u2', is_owner: true, branch_names: [] })],
      error: null,
    });
    const people = await listShopPeople(['shop-1', 'shop-2']);
    expect(people.get('shop-1')).toEqual([
      {
        userId: 'u1',
        shopId: 'shop-1',
        name: 'Sahra Ismaaciil',
        email: 'sahra@hooyo.so',
        phone: '0634418820',
        roleName: 'Cashier',
        permissions: ['sales.record'],
        isOwner: false,
        active: true,
        joinedAt: '2026-08-03T09:00:00Z',
        branchNames: ['Koodbuur'],
      },
    ]);
    expect(people.get('shop-2')?.[0].isOwner).toBe(true);
  });

  // The provisioning trigger falls back to the email's local part, so a truly
  // blank name is rare -- but an empty row is never rendered.
  it('falls back to "Owner" rather than rendering a nameless row', async () => {
    mockRpc.mockResolvedValue({ data: [row({ full_name: null, is_owner: true })], error: null });
    const people = await listShopPeople(['shop-1']);
    expect(people.get('shop-1')?.[0].name).toBe('Owner');
  });

  it('falls back to "Team member" for a nameless non-owner', async () => {
    mockRpc.mockResolvedValue({ data: [row({ full_name: null })], error: null });
    const people = await listShopPeople(['shop-1']);
    expect(people.get('shop-1')?.[0].name).toBe('Team member');
  });

  it('throws when the read fails, so the caller can say so', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    await expect(listShopPeople(['shop-1'])).rejects.toBeDefined();
  });

  it('returns people already sorted, owner first', async () => {
    mockRpc.mockResolvedValue({
      data: [
        row({ user_id: 'gone', full_name: 'Cabdi', active: false }),
        row({ user_id: 'owner', full_name: 'Faadumo', is_owner: true }),
      ],
      error: null,
    });
    const people = await listShopPeople(['shop-1']);
    expect(people.get('shop-1')?.map((p) => p.userId)).toEqual(['owner', 'gone']);
  });
});
