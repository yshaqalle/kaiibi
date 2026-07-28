// The fixed catalog of grantable capabilities. Roles are dynamic (an admin
// creates/renames/deletes them and picks which of these a role grants), but
// the catalog itself is defined here in code, not user-editable -- this is
// what `roles.permissions text[]` values are validated against.
//
// Not yet consumed by any gate (that's Phase 3) -- Phase 1 only defines the
// catalog so the Roles UI (Phase 2) has something to build a checkbox list
// from.
export type Permission =
  | 'pos.access'
  | 'inventory.view'
  | 'inventory.edit'
  | 'sales.view'
  | 'sales.edit'
  | 'dashboard.view'
  | 'settings.access'
  | 'staff.manage';

export const PERMISSIONS: { key: Permission; label: string; description: string }[] = [
  { key: 'pos.access', label: 'Access POS', description: 'Use the register to ring up sales and take payment.' },
  { key: 'inventory.view', label: 'View inventory', description: 'See the product list and stock levels.' },
  { key: 'inventory.edit', label: 'Edit inventory', description: 'Add, edit, or delete products and adjust stock.' },
  { key: 'sales.view', label: 'View sales history', description: 'See past sales and receipts.' },
  { key: 'sales.edit', label: 'Edit/delete sales', description: 'Edit or delete a past sale.' },
  { key: 'dashboard.view', label: 'View dashboard', description: 'See revenue, trends, and other shop analytics.' },
  { key: 'settings.access', label: 'Access settings', description: 'View and change shop settings, tax, and catalog.' },
  { key: 'staff.manage', label: 'Manage staff', description: 'Create roles and add or remove staff accounts.' },
];

// `inventory.edit` doesn't imply `inventory.view` at the DB/RLS level -- a
// role editor UI should auto-check/lock `inventory.view` when
// `inventory.edit` is toggled on as a UX convenience, but the stored
// permission set is always the explicit array.
export const IMPLIED_PERMISSIONS: Partial<Record<Permission, Permission[]>> = {
  'inventory.edit': ['inventory.view'],
};
