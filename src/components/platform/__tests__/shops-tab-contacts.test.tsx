import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ShopsTab } from '@/components/platform/shops-tab';
import type { PlatformShopRow, ShopPerson } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

const owner = (over: Partial<ShopPerson> = {}): ShopPerson => ({
  userId: 'owner-1',
  shopId: 'shop-1',
  name: 'Faadumo Cabdi',
  email: 'faadumo@hooyo.so',
  phone: '0634418820',
  roleName: 'Owner',
  permissions: [],
  isOwner: true,
  active: true,
  joinedAt: '2026-07-14T09:00:00Z',
  branchNames: [],
  ...over,
});

const shop = (over: Partial<PlatformShopRow> = {}): PlatformShopRow => ({
  shopId: 'shop-1',
  shopName: 'Hooyo Market',
  ownerId: 'owner-1',
  createdAt: '2026-07-14T09:00:00Z',
  planKey: 'standard',
  planName: 'Standard',
  storedPlanKey: 'standard',
  storedPlanName: 'Standard',
  retiringTo: null,
  status: 'trialing',
  trialEndsAt: '2026-08-18T09:00:00Z',
  currentPeriodEnd: null,
  manualStatus: 'active',
  usage: {},
  limits: {},
  branches: [
    { id: 'l1', name: 'Main', city: 'Hargeisa', neighborhood: 'Jigjiga Yar', phone: '0634418820', isPrimary: true },
  ],
  people: [owner()],
  owner: owner(),
  alsoOwns: [],
  ...over,
});

const plans: Plan[] = [];

function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((n) => (typeof n.props.children === 'string' ? [n.props.children] : []));
}

function render(rows: PlatformShopRow[]) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<ShopsTab shops={rows} plans={plans} compact={false} selected={null} onSelect={() => {}} />);
  });
  return tree;
}

describe('the Store cell', () => {
  it('names the owner and the city beside the plan', () => {
    expect(texts(render([shop()]))).toContain('Faadumo Cabdi · Hargeisa · Standard');
  });

  it('counts the other branches rather than listing three towns', () => {
    const tree = render([
      shop({
        branches: [
          { id: 'l1', name: 'Main', city: 'Burco', neighborhood: null, phone: null, isPrimary: true },
          { id: 'l2', name: 'Two', city: 'Hargeisa', neighborhood: null, phone: null, isPrimary: false },
          { id: 'l3', name: 'Three', city: 'Berbera', neighborhood: null, phone: null, isPrimary: false },
        ],
      }),
    ]);
    expect(texts(tree)).toContain('Faadumo Cabdi · Burco +2 · Standard');
  });

  it('falls back to the plan alone when the roster did not load', () => {
    expect(texts(render([shop({ people: [], owner: null, branches: [] })]))).toContain('Standard');
  });

  // Real stores sign up without typing a name, and the whole address lands in
  // full_name -- three long things then fight for one line.
  it('shows the local part when the owner’s name is an email address', () => {
    const t = texts(render([shop({ owner: owner({ name: 'mmooge@gmail.com' }) })]));
    expect(t).toContain('mmooge · Hargeisa · Standard');
  });
});

describe('the Contact cell', () => {
  it('offers WhatsApp when there is a number', () => {
    const t = texts(render([shop()]));
    expect(t).toContain('0634418820');
    expect(t).not.toContain('no contact');
  });

  // Nine rows in eleven had no number at all, and every one of them has an
  // email we already hold. "no number" was a column saying what you cannot do.
  it('falls back to the owner’s email rather than a dead end', () => {
    const t = texts(
      render([
        shop({
          owner: owner({ phone: null }),
          branches: [{ id: 'l1', name: 'Main', city: 'Hargeisa', neighborhood: null, phone: null, isPrimary: true }],
        }),
      ])
    );
    // The local part: a full address truncates to nothing useful in 190px,
    // and the button carries the real one.
    expect(t).toContain('faadumo');
    expect(t).not.toContain('no contact');
  });

  it('says "no contact" only when there is genuinely neither', () => {
    const t = texts(
      render([
        shop({
          owner: owner({ phone: null, email: null }),
          branches: [{ id: 'l1', name: 'Main', city: 'Hargeisa', neighborhood: null, phone: null, isPrimary: true }],
        }),
      ])
    );
    expect(t).toContain('no contact');
  });
});

describe('search', () => {
  function search(tree: ReactTestRenderer, query: string) {
    act(() => tree.root.findAllByType(TextInput)[0].props.onChangeText(query));
  }

  it('finds a store by its owner’s name', () => {
    const tree = render([shop(), shop({ shopId: 'shop-2', shopName: 'Xamdi Pharmacy', people: [], owner: null })]);
    search(tree, 'faadumo');
    expect(texts(tree)).toContain('Hooyo Market');
    expect(texts(tree)).not.toContain('Xamdi Pharmacy');
  });

  it('finds a store by the last digits of the owner’s number', () => {
    const tree = render([shop()]);
    search(tree, '8820');
    expect(texts(tree)).toContain('Hooyo Market');
  });

  it('finds a store by a branch city', () => {
    const tree = render([
      shop({ branches: [{ id: 'l1', name: 'Main', city: 'Burco', neighborhood: null, phone: null, isPrimary: true }] }),
    ]);
    search(tree, 'burco');
    expect(texts(tree)).toContain('Hooyo Market');
  });

  it('still finds a store by its own name', () => {
    const tree = render([shop()]);
    search(tree, 'hooyo');
    expect(texts(tree)).toContain('Hooyo Market');
  });
});
