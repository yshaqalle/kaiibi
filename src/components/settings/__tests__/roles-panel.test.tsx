import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { RolesPanel } from '@/components/settings/panels/roles-panel';
import type { Role } from '@/types/models';

// The nesting has to be REAL, not visual. Turning "Change stock" off must turn
// both children off and disable them -- otherwise a shop reads a role as
// count-free while roles.permissions still says otherwise, and the database
// believes the array.
//
// Driven through the panel's own toggle handler rather than through
// expandPermissions directly, because the bug this guards against lives in the
// component: `togglePermission` clears dependents when a parent goes off, and a
// child rendered from a flat list would keep its own switch live.

jest.mock('@/lib/staff', () => ({
  createRole: jest.fn(async () => {}),
  updateRole: jest.fn(async () => {}),
  deleteRole: jest.fn(async () => {}),
}));
const { updateRole } = jest.requireMock('@/lib/staff') as { updateRole: jest.Mock };

const STOCKROOM = {
  id: 'role-1',
  shopId: 'shop-1',
  name: 'Stockroom',
  permissions: ['inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as never;

// What a client lagging an OTA update would read back: a permission a newer
// client already granted, that this build's PERMISSIONS array doesn't know.
const LEGACY = {
  id: 'role-2',
  shopId: 'shop-1',
  name: 'Legacy',
  permissions: ['inventory.view', 'inventory.edit', 'loyalty.manage'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as never;

// Holds only the child -- no 'inventory.edit', no 'inventory.view' in the
// stored array at all. Nothing in the database prevents this shape; the
// editor has to make sense of it on its own.
const COUNT_ONLY = {
  id: 'role-3',
  shopId: 'shop-1',
  name: 'Counter',
  permissions: ['inventory.count'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as never;

function rowFor(tree: ReactTestRenderer, label: string): ReactTestInstance {
  // RN's Pressable forwards accessibilityLabel through its own internal
  // layers (the composite Pressable, an inner forwardRef View, the host
  // View), so a bare accessibilityLabel match returns 3 instances even for a
  // single, correctly-drawn row -- only the outermost carries a real
  // `onPress` function (the inner layers implement touch handling their own
  // way), so filtering on that isolates exactly one match per row actually
  // authored in JSX. A permission drawn twice (see permission-groups.test.ts's
  // "draws every permission exactly once") would surface here as 2, not
  // hide behind a bare `[0]`.
  const matches = tree.root.findAll((n) => n.props.accessibilityLabel === `Permission: ${label}` && typeof n.props.onPress === 'function');
  expect(matches).toHaveLength(1);
  return matches[0];
}

async function openEditor(role: Role = STOCKROOM): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <RolesPanel shopId="shop-1" roles={[role]} usage={new Map()} onChange={async () => {}} />
    );
  });
  await act(async () => tree.root.findAll((n) => n.props.accessibilityLabel === `Edit ${role.name}`)[0].props.onPress());
  return tree;
}

beforeEach(() => updateRole.mockClear());

describe('the nested inventory permissions', () => {
  it('shows the two verbs under the permission they sit inside', async () => {
    const tree = await openEditor();
    expect(rowFor(tree, '… count and write off').props.accessibilityState.checked).toBe(true);
    expect(rowFor(tree, '… move between stores').props.accessibilityState.checked).toBe(true);
  });

  // What a shop actually does with this screen: keep the stockroom receiving
  // deliveries, stop them writing stock off.
  it('turns one child off without touching the parent or its sibling', async () => {
    const tree = await openEditor();
    await act(async () => rowFor(tree, '… count and write off').props.onPress());
    await act(async () => tree.root.findAll((n) => n.props.accessibilityLabel === 'Save role')[0].props.onPress());
    expect(updateRole.mock.calls[0][1].permissions).toEqual([
      'inventory.view',
      'inventory.edit',
      'inventory.transfer',
    ]);
  });

  // The cascade. Not a courtesy: leaving a child on under an off parent stores
  // an array the database reads as "may count", on a role the screen shows as
  // unable to change stock at all.
  it('turns both children off when the parent goes off', async () => {
    const tree = await openEditor();
    await act(async () => rowFor(tree, 'Change stock').props.onPress());
    expect(rowFor(tree, '… count and write off').props.accessibilityState.checked).toBe(false);
    expect(rowFor(tree, '… count and write off').props.accessibilityState.disabled).toBe(true);
    await act(async () => tree.root.findAll((n) => n.props.accessibilityLabel === 'Save role')[0].props.onPress());
    expect(updateRole.mock.calls[0][1].permissions).toEqual(['inventory.view']);
  });

  // And a disabled child does nothing when pressed, rather than quietly
  // switching the parent back on behind it.
  it('ignores a press on a disabled child', async () => {
    const tree = await openEditor();
    await act(async () => rowFor(tree, 'Change stock').props.onPress());
    await act(async () => rowFor(tree, '… count and write off').props.onPress());
    expect(rowFor(tree, 'Change stock').props.accessibilityState.checked).toBe(false);
    expect(rowFor(tree, '… count and write off').props.accessibilityState.checked).toBe(false);
  });
});

// expandPermissions (src/lib/permissions.ts) drops any string not in
// ALL_PERMISSIONS -- by design everywhere else it's used, but this panel is
// what seeds its own state from the raw stored array AND saves back through
// it, so a permission this client's catalogue doesn't recognize must not be
// silently stripped just because an admin opened and edited an unrelated row.
describe('a permission this catalogue does not recognize', () => {
  it('survives an unrelated toggle and a save', async () => {
    const tree = await openEditor(LEGACY);
    await act(async () => rowFor(tree, '… count and write off').props.onPress());
    await act(async () => tree.root.findAll((n) => n.props.accessibilityLabel === 'Save role')[0].props.onPress());
    expect(updateRole.mock.calls[0][1].permissions).toEqual(expect.arrayContaining(['loyalty.manage']));
  });
});

// The `disabled={!permissions.includes(permission.key)}` rule on a child row
// assumes a checked child implies a checked parent -- true once a save has
// gone through expandPermissions, but nothing enforces it on LOAD unless the
// editor's own seed does the same folding. Without it, a role holding only
// the child renders the child checked-but-disabled and the parent unchecked:
// a switch the shop can see is on, but cannot turn off.
describe('a role that was granted only a child permission', () => {
  it('renders the parent checked too, and the child enabled', async () => {
    const tree = await openEditor(COUNT_ONLY);
    expect(rowFor(tree, 'Change stock').props.accessibilityState.checked).toBe(true);
    expect(rowFor(tree, '… count and write off').props.accessibilityState.checked).toBe(true);
    expect(rowFor(tree, '… count and write off').props.accessibilityState.disabled).toBe(false);
  });
});
