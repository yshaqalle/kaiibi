import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ShopDrawer } from '@/components/platform/shop-drawer';
import type { PlatformShopRow, ShopPerson } from '@/lib/platform';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));
jest.mock('@/lib/platform', () => ({
  ...jest.requireActual('@/lib/platform'),
  callPlatformAdmin: jest.fn(),
}));

const person = (over: Partial<ShopPerson> & { userId: string }): ShopPerson => ({
  shopId: 'shop-1',
  name: 'Somebody',
  email: 'somebody@hooyo.so',
  phone: null,
  roleName: 'Cashier',
  permissions: [],
  isOwner: false,
  active: true,
  joinedAt: '2026-08-03T09:00:00Z',
  branchNames: [],
  ...over,
});

const owner = person({
  userId: 'o',
  name: 'Faadumo Cabdi',
  roleName: 'Owner',
  isOwner: true,
  phone: '0634418820',
  email: 'faadumo@hooyo.so',
});
const maxamed = person({
  userId: 'm',
  name: 'Maxamed Aadan',
  roleName: 'Manager',
  phone: '0637710043',
  email: 'maxamed@hooyo.so',
});
const nasra = person({ userId: 'n', name: 'Nasra Xasan', branchNames: ['Koodbuur'] });
const cabdi = person({ userId: 'c', name: 'Cabdi Jibriil', active: false });

const shop: PlatformShopRow = {
  shopId: 'shop-1',
  shopName: 'Hooyo Market',
  ownerId: 'o',
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
  usage: { staff: 4, locations: 2 },
  limits: { staff: 11, locations: 3 },
  branches: [
    { id: 'l1', name: 'Main', city: 'Hargeisa', neighborhood: 'Jigjiga Yar', phone: '0634418820', isPrimary: true },
    { id: 'l2', name: 'Koodbuur', city: 'Hargeisa', neighborhood: 'Koodbuur', phone: null, isPrimary: false },
  ],
  people: [owner, maxamed, nasra, cabdi],
  owner,
  alsoOwns: [],
};

function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((n) => (typeof n.props.children === 'string' ? [n.props.children] : []));
}

function render(over: Partial<PlatformShopRow> = {}, peopleError: string | null = null) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ShopDrawer
        shop={{ ...shop, ...over }}
        plans={[]}
        peopleError={peopleError}
        onDone={async () => {}}
        onMessage={() => {}}
      />
    );
  });
  return tree;
}

// By aria-label rather than by component type: Pressable renders through a
// forwardRef whose identity findAllByType does not match under this preset.
function press(tree: ReactTestRenderer, label: string) {
  const target = tree.root.findAll((n) => n.props?.['aria-label'] === label)[0];
  act(() => target.props.onPress());
}

describe('the store view', () => {
  it('shows the owner in full', () => {
    expect(texts(render())).toContain('Faadumo Cabdi');
  });

  it('summarises the team as one row rather than unrolling it', () => {
    const t = texts(render());
    expect(t).toContain('Maxamed, Nasra · 1 who has left');
    // The other three are behind the tap, not on this screen.
    expect(t).not.toContain('Cabdi Jibriil');
  });

  it('lists every branch with its city', () => {
    const t = texts(render());
    expect(t).toContain('Jigjiga Yar, Hargeisa · 0634418820');
    expect(t).toContain('Koodbuur, Hargeisa · no phone on file');
  });

  it('no longer repeats the seat count as a Usage row', () => {
    expect(texts(render())).not.toContain('Staff');
  });

  it('says so when the roster failed to load, without blanking the drawer', () => {
    const t = texts(render({}, 'permission denied'));
    expect(t.some((s) => s.includes('Could not load who works at this store'))).toBe(true);
    // The rest of the drawer is still there.
    expect(t).toContain('USAGE');
  });

  // Seen on the real console: "…this store: Could not load who works at these
  // stores.. Everything else here is current." The reason is a clause, so a
  // thrower's trailing full stop must not land mid-sentence.
  it('does not double the full stop when the reason ends in one', () => {
    const t = texts(render({}, 'Could not load who works at these stores.'));
    expect(t.some((s) => s.includes('..'))).toBe(false);
  });

  // "0 of ∞ seats" is what a Trial store's header first read; "PEOPLE · 4
  // PEOPLE" is what my fix for it read. The heading already says the word.
  it('never offers a seat count against an infinite cap, or repeats itself', () => {
    const t = texts(render({ limits: {} }));
    expect(t.some((s) => s.includes('∞'))).toBe(false);
    expect(t).toContain('PEOPLE · 4');
  });

  it('keeps the cap where there is one, because there the number is a budget', () => {
    expect(texts(render())).toContain('PEOPLE · 4 OF 11 SEATS');
  });

  it('names the owner’s other stores, because that is one conversation not two', () => {
    expect(texts(render({ alsoOwns: ['Hooyo Wholesale'] }))).toContain('Also owns Hooyo Wholesale');
  });

  it('says nothing about other stores for someone who owns one', () => {
    expect(texts(render()).some((s) => s.startsWith('Also owns'))).toBe(false);
  });

  it('says nothing about a team when there is only the owner', () => {
    const t = texts(render({ people: [owner] }));
    expect(t.some((s) => s.includes('who has left'))).toBe(false);
  });
});

describe('the team view', () => {
  it('opens on the roster and names everyone', () => {
    const tree = render();
    press(tree, 'Their team');
    const t = texts(tree);
    expect(t).toContain('Maxamed Aadan');
    expect(t).toContain('Cabdi Jibriil');
    expect(t).toContain('Working here');
    expect(t).toContain('No longer here');
  });

  // The rule can_access_location() enforces, stated the right way round.
  it('labels an unassigned member as reaching every branch', () => {
    const tree = render();
    press(tree, 'Their team');
    expect(texts(tree)).toContain('Both branches');
  });

  it('names the one branch an assigned member is tied to', () => {
    const tree = render();
    press(tree, 'Their team');
    expect(texts(tree)).toContain('Koodbuur');
  });

  it('gives a person’s email and phone when their row is tapped', () => {
    const tree = render();
    press(tree, 'Their team');
    press(tree, 'Maxamed Aadan, Manager');
    const t = texts(tree);
    expect(t).toContain('maxamed@hooyo.so');
    expect(t).toContain('0637710043');
  });

  it('goes back to the store', () => {
    const tree = render();
    press(tree, 'Their team');
    press(tree, 'Back to Hooyo Market');
    expect(texts(tree)).toContain('USAGE');
  });
});
