import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { RolesPanel } from '@/components/settings/panels/roles-panel';

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

function rowFor(tree: ReactTestRenderer, label: string): ReactTestInstance {
  return tree.root.findAll((n) => n.props.accessibilityLabel === `Permission: ${label}`)[0];
}

async function openEditor(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <RolesPanel shopId="shop-1" roles={[STOCKROOM]} usage={new Map()} onChange={async () => {}} />
    );
  });
  await act(async () => tree.root.findAll((n) => n.props.accessibilityLabel === 'Edit Stockroom')[0].props.onPress());
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
