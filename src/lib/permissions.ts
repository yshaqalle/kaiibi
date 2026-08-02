// The fixed catalog of grantable capabilities. Roles are dynamic (an admin
// creates/renames/deletes them and picks which of these a role grants), but
// the catalog itself is defined here in code, not user-editable -- this is
// what `roles.permissions text[]` values are validated against.
//
// Enforced in two places, and both are required: the DB (migration 0024's
// RLS policies + has_shop_permission(), which is what actually stops a
// cashier reading sales straight off the API) and the client (the route
// guard in app/(admin)/_layout.tsx plus the nav/action gates, so the UI never
// offers something the DB will refuse).
export type Permission =
  | 'pos.access'
  | 'inventory.view'
  | 'inventory.edit'
  | 'sales.view'
  | 'sales.edit'
  | 'sales.refund'
  | 'customers.view'
  | 'customers.edit'
  | 'dashboard.view'
  | 'settings.access'
  | 'staff.manage';

export const PERMISSIONS: { key: Permission; label: string; description: string }[] = [
  { key: 'pos.access', label: 'Access POS', description: 'Use the register to ring up sales and take payment.' },
  { key: 'inventory.view', label: 'View inventory', description: 'See the product list and stock levels.' },
  { key: 'inventory.edit', label: 'Edit inventory', description: 'Add, edit, or delete products and adjust stock.' },
  { key: 'sales.view', label: 'View sales history', description: 'See past sales and receipts.' },
  { key: 'sales.edit', label: 'Edit/delete sales', description: 'Edit or delete a past sale.' },
  { key: 'sales.refund', label: 'Refund sales', description: 'Issue refunds against past sales and restore stock. Independent of sales editing.' },
  { key: 'customers.view', label: 'View customers', description: 'Browse the customer directory and its contact details.' },
  { key: 'customers.edit', label: 'Edit customers', description: 'Add, edit, or delete customer records.' },
  { key: 'dashboard.view', label: 'View dashboard', description: 'See revenue, trends, and other shop analytics.' },
  { key: 'settings.access', label: 'Access settings', description: 'View and change shop settings, tax, and catalog.' },
  { key: 'staff.manage', label: 'Manage staff', description: 'Create roles and add or remove staff accounts.' },
];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.key);

// `inventory.edit` doesn't imply `inventory.view` at the DB/RLS level -- a
// role editor UI should auto-check/lock `inventory.view` when
// `inventory.edit` is toggled on as a UX convenience, but the stored
// permission set is always the explicit array.
export const IMPLIED_PERMISSIONS: Partial<Record<Permission, Permission[]>> = {
  'inventory.edit': ['inventory.view'],
  'sales.edit': ['sales.view'],
  'sales.refund': ['sales.view'],
  'customers.edit': ['customers.view'],
};

// Turns a stored `roles.permissions` array into the effective set the client
// gates on: unknown strings are dropped (a role row could predate a catalog
// change) and IMPLIED_PERMISSIONS are folded in, so a role granting only
// `inventory.edit` still resolves as able to open the Inventory screen.
export function expandPermissions(stored: readonly string[]): Permission[] {
  const known = new Set<Permission>();
  for (const entry of stored) {
    if (!(ALL_PERMISSIONS as string[]).includes(entry)) continue;
    const permission = entry as Permission;
    known.add(permission);
    for (const implied of IMPLIED_PERMISSIONS[permission] ?? []) known.add(implied);
  }
  return ALL_PERMISSIONS.filter((p) => known.has(p));
}

// Every route inside the `(admin)` group and the permission it needs. Keys
// are matched longest-first as path prefixes, so `/product/new` resolves via
// `/product`. Anything not listed here is unrestricted for a signed-in
// member (e.g. `/marketplace-coming-soon`).
const ROUTE_PERMISSIONS: { prefix: string; permission: Permission }[] = [
  { prefix: '/dashboard', permission: 'dashboard.view' },
  { prefix: '/pos', permission: 'pos.access' },
  { prefix: '/inventory', permission: 'inventory.view' },
  { prefix: '/product', permission: 'inventory.edit' },
  { prefix: '/customers', permission: 'customers.view' },
  { prefix: '/sales', permission: 'sales.view' },
  { prefix: '/settings', permission: 'settings.access' },
  { prefix: '/account', permission: 'staff.manage' },
];

export function permissionForPath(pathname: string): Permission | null {
  const match = [...ROUTE_PERMISSIONS]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`));
  return match?.permission ?? null;
}

// Where to send someone who has no business on the route they asked for --
// their first permitted tab, in the tab bar's own order. Null when their role
// grants nothing at all (the "no access" screen in (admin)/_layout.tsx).
const LANDING_ROUTES = [
  { href: '/dashboard', permission: 'dashboard.view' },
  { href: '/pos', permission: 'pos.access' },
  { href: '/inventory', permission: 'inventory.view' },
  { href: '/customers', permission: 'customers.view' },
  { href: '/sales', permission: 'sales.view' },
] as const satisfies readonly { href: string; permission: Permission }[];

export type LandingRoute = (typeof LANDING_ROUTES)[number]['href'];

export function firstAllowedRoute(permissions: readonly Permission[]): LandingRoute | null {
  return LANDING_ROUTES.find((route) => permissions.includes(route.permission))?.href ?? null;
}
