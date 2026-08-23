import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from '@/lib/permissions';

type PermissionEntry = (typeof PERMISSIONS)[number];

// Groups the permission catalog into the 4 buckets the Team detail pane's
// read-only Access & permissions grid shows (Task 12) -- purely a display
// grouping, not a data-model concept.
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  // `registers.manage` sits with POS rather than Accounting because it is
  // exercised at the counter: opening a register for a colleague and signing off
  // their drawer count. Everyone with pos.access already opens and closes their
  // own — this is only the supervisory half.
  { label: 'POS', permissions: ['pos.access', 'registers.manage', 'discounts.apply', 'discounts.manual'] },
  { label: 'Inventory', permissions: ['inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer'] },
  {
    label: 'People',
    permissions: ['customers.view', 'customers.edit', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view', 'people.schedule.manage'],
  },
  {
    label: 'Accounting',
    permissions: [
      'sales.view',
      'sales.edit',
      'sales.refund',
      'expenses.view',
      'expenses.manage',
      'invoices.view',
      'invoices.manage',
      'budgets.manage',
      'dashboard.view',
      'settings.access',
    ],
  },
];

export function groupHasAny(permissions: readonly string[], group: { permissions: Permission[] }): boolean {
  return group.permissions.some((p) => permissions.includes(p));
}

// The catalogue as the role editor draws it: groups, each holding parent rows,
// each parent holding its children.
//
// Built from PERMISSION_GROUPS and PERMISSIONS rather than from a third list,
// so a new permission cannot be added to the catalogue and forgotten here --
// and anything filed in no group at all lands in a trailing "Other" rather than
// vanishing, which is what a plain `filter` would do to it. A permission nobody
// can see is a permission nobody can grant, and it fails as silence.
export function groupedPermissions(): {
  label: string;
  rows: { permission: PermissionEntry; children: PermissionEntry[] }[];
}[] {
  const childrenOf = (key: Permission) => PERMISSIONS.filter((p) => p.parent === key);
  const grouped = PERMISSION_GROUPS.map((group) => ({
    label: group.label,
    rows: PERMISSIONS.filter((p) => group.permissions.includes(p.key) && p.parent === undefined).map((permission) => ({
      permission,
      children: childrenOf(permission.key),
    })),
  }));
  const filed = new Set(PERMISSION_GROUPS.flatMap((g) => g.permissions));
  const orphans = PERMISSIONS.filter((p) => !filed.has(p.key) && p.parent === undefined);
  const result = orphans.length > 0
    ? [...grouped, { label: 'Other', rows: orphans.map((permission) => ({ permission, children: childrenOf(permission.key) })) }]
    : grouped;

  // A permission the editor cannot draw is a permission nobody can grant --
  // the exact silent hole the comment above exists to prevent. `childrenOf`
  // only walks one level, so a permission whose `parent` names a CHILD (a
  // grandchild) is invisible to every row above: not a top-level row (it has
  // a parent) and not nested under anything either (nothing looks for
  // children of a child). Cheap to check on every call, and a config mistake
  // in PERMISSIONS/PERMISSION_GROUPS is a bug for the developer who wrote it,
  // not something a shop should ever see silently swallowed into a stripped
  // role -- so this throws instead of returning a catalogue short (or long,
  // if a permission was drawn twice) a row.
  //
  // Dev only, deliberately. Nothing data-borne can reach this: the function
  // takes no arguments and reads only PERMISSIONS and PERMISSION_GROUPS, both
  // module constants shipped in the same bundle. So for any given build it
  // raises for everyone or for no one -- it is a build-time assertion, and the
  // permission-groups test already fails on both a missing and a duplicated
  // row without it. Ungated it would buy nothing in CI and cost a shop the
  // whole Settings route: roles-panel.tsx calls this at module scope, and the
  // app has no ErrorBoundary, so a raise here is a failed module evaluation
  // rather than one missing checkbox.
  const drawn = result.flatMap((g) => g.rows.flatMap((r) => [r.permission.key, ...r.children.map((c) => c.key)]));
  const sortedDrawn = [...drawn].sort();
  const sortedAll = [...ALL_PERMISSIONS].sort();
  const matches = sortedDrawn.length === sortedAll.length && sortedDrawn.every((key, i) => key === sortedAll[i]);
  if (__DEV__ && !matches) {
    throw new Error(
      `groupedPermissions() drew ${drawn.length} row(s) for a ${ALL_PERMISSIONS.length}-permission catalogue -- check PERMISSIONS parent links and PERMISSION_GROUPS filing.`
    );
  }

  return result;
}
