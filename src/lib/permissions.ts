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
  | 'staff.manage'
  | 'people.timeoff.approve'
  | 'people.payroll.manage'
  | 'people.timesheet.view'
  | 'people.schedule.manage'
  | 'expenses.view'
  | 'expenses.manage'
  | 'invoices.view'
  | 'invoices.manage'
  | 'budgets.manage'
  | 'ledger.view'
  | 'ledger.manage'
  | 'registers.manage'
  | 'discounts.apply'
  | 'discounts.manual';

export const PERMISSIONS: { key: Permission; label: string; description: string }[] = [
  { key: 'pos.access', label: 'Access POS', description: 'Use the register to ring up sales and take payment.' },
  { key: 'inventory.view', label: 'View inventory', description: 'See the product list and stock levels.' },
  { key: 'inventory.edit', label: 'Edit inventory', description: 'Add, edit, or delete products and adjust stock.' },
  { key: 'sales.view', label: 'View sales history', description: 'See past sales and receipts.' },
  { key: 'sales.edit', label: 'Edit/delete sales', description: 'Edit or delete a past sale.' },
  { key: 'sales.refund', label: 'Refund sales', description: 'Issue refunds against past sales and restore stock. Independent of sales editing.' },
  { key: 'discounts.apply', label: 'Apply an offer', description: "Put one of the shop's own offers on a sale. The amount is the offer's, not the cashier's." },
  { key: 'discounts.manual', label: 'Enter a discount', description: 'Type any amount off a line or a whole sale. Independent of applying an offer — this is the one with no ceiling.' },
  { key: 'customers.view', label: 'View customers', description: 'Browse the customer directory and its contact details.' },
  { key: 'customers.edit', label: 'Edit customers', description: 'Add, edit, or delete customer records.' },
  { key: 'dashboard.view', label: 'View dashboard', description: 'See revenue, trends, and other shop analytics.' },
  { key: 'settings.access', label: 'Access settings', description: 'View and change shop settings, tax, and catalog.' },
  { key: 'staff.manage', label: 'Manage team roster', description: 'Create roles and add or remove staff accounts.' },
  { key: 'people.timeoff.approve', label: 'Approve time off', description: 'Approve or deny staff time-off requests.' },
  { key: 'people.payroll.manage', label: 'Manage payroll', description: 'Set hire date, pay type, and pay rate for staff.' },
  { key: 'people.timesheet.view', label: 'View team hours', description: "See the whole team's clock-in history and shift hours, not just your own." },
  { key: 'people.schedule.manage', label: 'Manage the schedule', description: "Create and change shifts for the whole team. Everyone can see their own shifts without this." },
  { key: 'expenses.view', label: 'View expenses', description: 'See logged expenses and what the shop is spending.' },
  { key: 'expenses.manage', label: 'Manage expenses', description: 'Log, edit, or delete expenses and record recurring bills.' },
  { key: 'invoices.view', label: 'View bills', description: 'See bills owed to vendors and what is still outstanding.' },
  { key: 'invoices.manage', label: 'Manage bills', description: 'Record vendor bills and mark payments against them.' },
  { key: 'budgets.manage', label: 'Manage budgets and cash', description: 'Set category budgets, recurring bills, and cash-on-hand balances.' },
  { key: 'ledger.view', label: 'View the ledger', description: 'See the chart of accounts, the journal, the trial balance, the asset register and the audit log.' },
  { key: 'ledger.manage', label: 'Keep the books', description: 'Change the chart of accounts, post and reverse journal entries, and record fixed assets. Independent of viewing — this is the one that can move the bottom line with no sale or receipt behind it.' },
  { key: 'registers.manage', label: 'Manage registers', description: "Open a register for someone else, close anyone's register, and sign off cash variance. Everyone with POS access can open and close their own." },
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
  'people.payroll.manage': ['people.timesheet.view'],
  'expenses.manage': ['expenses.view'],
  'invoices.manage': ['invoices.view'],
  'ledger.manage': ['ledger.view'],
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

// Every route inside the `(admin)` group and the permission(s) it needs.
// Keys are matched longest-first as path prefixes, so `/product/new`
// resolves via `/product`. An array means "any of these" -- /people is
// valid with customers.view (Customers sub-tab) OR any of the People-
// manager permissions (Team sub-tab). Anything not listed here is
// unrestricted for a signed-in member (e.g. `/marketplace-coming-soon`,
// and deliberately `/me` -- self-service HR is gated on active membership,
// not a Permission; see (admin)/_layout.tsx).
const ROUTE_PERMISSIONS: { prefix: string; permission: Permission | Permission[] }[] = [
  { prefix: '/dashboard', permission: 'dashboard.view' },
  { prefix: '/pos', permission: 'pos.access' },
  { prefix: '/inventory', permission: 'inventory.view' },
  { prefix: '/product', permission: 'inventory.edit' },
  // In practice this list is never what grants a schedule-only (or any
  // other People-manager) role access to /people: (admin)/_layout.tsx
  // short-circuits the check for `/people` via `isPeopleRoute && canReachMe`
  // -- true for any active member, via the self-service path -- before
  // `required.some(can)` is even reached. This entry stays anyway so the
  // catalogue documents intent (which permissions *should* justify reaching
  // /people) consistently with every other route here.
  { prefix: '/people', permission: ['customers.view', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view', 'people.schedule.manage'] },
  // Accounting is gated on sales.view: its Transactions tab *is* the sales
  // history, and "can see what the shop takes" is the right bar for the
  // screen as a whole. The expenses/invoices read policies separately accept
  // sales.view too, so opening Accounting always shows coherent totals. A
  // bookkeeper role that should see spend but not sales would need this to
  // become the array form (which this list supports) rather than a wider
  // single permission.
  { prefix: '/accounting', permission: 'sales.view' },
  { prefix: '/settings', permission: 'settings.access' },
];

export function permissionForPath(pathname: string): Permission[] | null {
  const match = [...ROUTE_PERMISSIONS]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`));
  if (!match) return null;
  return Array.isArray(match.permission) ? match.permission : [match.permission];
}

// Where to send someone who has no business on the route they asked for --
// their first permitted tab, in the tab bar's own order. Null when their role
// grants nothing at all (the "no access" screen in (admin)/_layout.tsx).
const LANDING_ROUTES = [
  { href: '/dashboard', permission: 'dashboard.view' },
  { href: '/pos', permission: 'pos.access' },
  { href: '/inventory', permission: 'inventory.view' },
  { href: '/people', permission: 'customers.view' },
  { href: '/accounting', permission: 'sales.view' },
] as const satisfies readonly { href: string; permission: Permission }[];

export type LandingRoute = (typeof LANDING_ROUTES)[number]['href'];

export function firstAllowedRoute(permissions: readonly Permission[]): LandingRoute | null {
  return LANDING_ROUTES.find((route) => permissions.includes(route.permission))?.href ?? null;
}
