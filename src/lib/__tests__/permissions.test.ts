import { PERMISSION_GROUPS } from '@/lib/permission-groups';
import {
  ALL_PERMISSIONS,
  expandPermissions,
  firstAllowedRoute,
  permissionForPath,
  PERMISSIONS,
  type Permission,
} from '@/lib/permissions';

// The seeded roles from migration 0020 (plus 0024's customers additions) are
// the concrete cases this gate has to get right.
const CASHIER: string[] = ['pos.access', 'inventory.view'];
const MANAGER: string[] = [
  'pos.access',
  'inventory.view',
  'inventory.edit',
  'sales.view',
  'sales.edit',
  'dashboard.view',
  'customers.view',
  'customers.edit',
];

describe('expandPermissions', () => {
  it('keeps a stored set as-is when it needs no implications', () => {
    expect(expandPermissions(CASHIER)).toEqual(['pos.access', 'inventory.view']);
  });

  it('folds in implied permissions so a writer can also read', () => {
    expect(expandPermissions(['inventory.edit'])).toEqual(['inventory.view', 'inventory.edit']);
    expect(expandPermissions(['sales.edit'])).toEqual(['sales.view', 'sales.edit']);
    expect(expandPermissions(['sales.refund'])).toEqual(['sales.view', 'sales.refund']);
    expect(expandPermissions(['customers.edit'])).toEqual(['customers.view', 'customers.edit']);
  });

  it('folds people.payroll.manage into also granting people.timesheet.view', () => {
    expect(expandPermissions(['people.payroll.manage'])).toEqual(['people.payroll.manage', 'people.timesheet.view']);
  });

  it('folds the accounting manage permissions into their read counterparts', () => {
    expect(expandPermissions(['expenses.manage'])).toEqual(['expenses.view', 'expenses.manage']);
    expect(expandPermissions(['invoices.manage'])).toEqual(['invoices.view', 'invoices.manage']);
  });

  it('drops entries that are not in the catalog', () => {
    expect(expandPermissions(['pos.access', 'reports.export', ''])).toEqual(['pos.access']);
  });

  it('deduplicates and returns catalog order regardless of stored order', () => {
    expect(expandPermissions(['inventory.view', 'inventory.edit', 'pos.access', 'inventory.view'])).toEqual([
      'pos.access',
      'inventory.view',
      'inventory.edit',
    ]);
  });

  it('resolves an empty role to no permissions at all', () => {
    expect(expandPermissions([])).toEqual([]);
  });
});

// The catalog is duplicated in three places that must agree: the `Permission`
// union (compile-time), the PERMISSIONS descriptions (the role editor's
// checkboxes), and PERMISSION_GROUPS (the Team tab's access grid). Only the
// first is enforced by the compiler -- a new permission silently missing from
// either list just disappears from a screen, with nothing failing.
describe('catalog completeness', () => {
  it('describes every permission in the catalog', () => {
    expect(PERMISSIONS.map((p) => p.key).sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('assigns every permission to exactly one access-grid group', () => {
    const grouped = PERMISSION_GROUPS.flatMap((group) => group.permissions);
    expect([...grouped].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});

describe('permissionForPath', () => {
  it.each([
    ['/dashboard', ['dashboard.view']],
    ['/pos', ['pos.access']],
    ['/inventory', ['inventory.view']],
    ['/accounting', ['sales.view']],
    ['/settings', ['settings.access']],
  ] as const)('gates %s on %s', (path, permissions) => {
    expect(permissionForPath(path)).toEqual(permissions);
  });

  it('gates /people on any permission that unlocks Customers, Team, or Schedule', () => {
    expect(permissionForPath('/people')).toEqual([
      'customers.view',
      'staff.manage',
      'people.timeoff.approve',
      'people.payroll.manage',
      'people.timesheet.view',
      'people.schedule.manage',
    ]);
  });

  it('gates the product detail screens on inventory.edit, not inventory.view', () => {
    expect(permissionForPath('/product/new')).toEqual(['inventory.edit']);
    expect(permissionForPath('/product/abc-123')).toEqual(['inventory.edit']);
  });

  it('leaves routes outside the catalog ungated, including /me (self-service HR)', () => {
    expect(permissionForPath('/marketplace-coming-soon')).toBeNull();
    expect(permissionForPath('/login')).toBeNull();
    expect(permissionForPath('/me')).toBeNull();
  });

  it('does not treat a longer unrelated segment as a prefix match', () => {
    expect(permissionForPath('/salesperson')).toBeNull();
  });
});

describe('firstAllowedRoute', () => {
  it('lands an admin on the dashboard', () => {
    expect(firstAllowedRoute(ALL_PERMISSIONS)).toBe('/dashboard');
  });

  it('lands a cashier on the POS, since the dashboard is off-limits', () => {
    expect(firstAllowedRoute(expandPermissions(CASHIER))).toBe('/pos');
  });

  it('lands a manager on the dashboard', () => {
    expect(firstAllowedRoute(expandPermissions(MANAGER))).toBe('/dashboard');
  });

  it('returns null when a role grants nothing navigable', () => {
    expect(firstAllowedRoute([])).toBeNull();
    // settings.access has no tab of its own -- it's reached from the nav
    // footer, so it alone is not a landing spot.
    expect(firstAllowedRoute(['settings.access'])).toBeNull();
  });
});

describe('discount permissions', () => {
  it('offers both discount capabilities in the catalog', () => {
    expect(ALL_PERMISSIONS).toContain('discounts.apply');
    expect(ALL_PERMISSIONS).toContain('discounts.manual');
  });

  it('describes them as separate capabilities', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(keys.filter((k) => k.startsWith('discounts.'))).toHaveLength(2);
  });

  it('does not imply one from the other — choosing an offer is not inventing a number', () => {
    expect(expandPermissions(['discounts.apply'])).toEqual(['discounts.apply']);
  });
});

describe('the cashier scope this gate exists to enforce', () => {
  const cashier = expandPermissions(CASHIER);
  const blocked: Permission[] = [
    'sales.view',
    'sales.edit',
    'sales.refund',
    'dashboard.view',
    'customers.view',
    'settings.access',
    'staff.manage',
    'inventory.edit',
    'people.timeoff.approve',
    'people.payroll.manage',
    'people.timesheet.view',
    'expenses.view',
    'expenses.manage',
    'invoices.view',
    'invoices.manage',
    'budgets.manage',
  ];

  it.each(blocked)('does not grant %s', (permission) => {
    expect(cashier).not.toContain(permission);
  });

  it('blocks every route a cashier should not reach', () => {
    for (const path of ['/dashboard', '/accounting', '/people', '/settings', '/product/new']) {
      const required = permissionForPath(path);
      expect(required).not.toBeNull();
      expect((required as Permission[]).some((p) => cashier.includes(p))).toBe(false);
    }
  });

  it('still grants the two routes a cashier works from', () => {
    expect(permissionForPath('/pos')!.some((p) => cashier.includes(p))).toBe(true);
    expect(permissionForPath('/inventory')!.some((p) => cashier.includes(p))).toBe(true);
  });
});

// The nesting is real, not visual: a role granting the child has to resolve
// the parent too, or someone who can count could not open the screen they
// count on. expandPermissions folds ONE level, so the parent's own implication
// (inventory.view) has to be listed here as well -- writing only
// ['inventory.edit'] and expecting the view to come along is the bug this case
// exists to catch.
describe('the inventory verbs', () => {
  it('resolves counting into editing and viewing', () => {
    expect(expandPermissions(['inventory.count'])).toEqual([
      'inventory.view',
      'inventory.edit',
      'inventory.count',
    ]);
  });

  it('resolves transferring the same way', () => {
    expect(expandPermissions(['inventory.transfer'])).toEqual([
      'inventory.view',
      'inventory.edit',
      'inventory.transfer',
    ]);
  });

  // What the migration's backfill produces, read back through the client.
  it('leaves a backfilled stockroom role holding all four', () => {
    expect(expandPermissions(['inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer'])).toEqual([
      'inventory.view',
      'inventory.edit',
      'inventory.count',
      'inventory.transfer',
    ]);
  });

  // The seeded Cashier is already read-only and stays that way -- the gap this
  // split closes is inside edit, not at the edge of it.
  it('gives a cashier neither verb', () => {
    expect(expandPermissions(CASHIER)).not.toContain('inventory.count');
    expect(expandPermissions(CASHIER)).not.toContain('inventory.transfer');
  });

  // Task 8's editor indents from this, and cascades a parent's OFF through it.
  it('names its parent so the editor can nest it', () => {
    const byKey = new Map(PERMISSIONS.map((p) => [p.key, p]));
    expect(byKey.get('inventory.count')?.parent).toBe('inventory.edit');
    expect(byKey.get('inventory.transfer')?.parent).toBe('inventory.edit');
    expect(byKey.get('inventory.edit')?.parent).toBeUndefined();
  });

  // The editor renders from the groups, so a permission missing from every group
  // would be a capability nobody could grant -- invisible, and only discoverable
  // by a shop wondering why a feature never works for their staff.
  it('files every permission in exactly one group', () => {
    const filed = PERMISSION_GROUPS.flatMap((g) => g.permissions);
    expect([...filed].sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(new Set(filed).size).toBe(filed.length);
  });
});
