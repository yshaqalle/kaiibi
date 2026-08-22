import type { Permission } from '@/lib/permissions';

// Groups the permission catalog into the 4 buckets the Team detail pane's
// read-only Access & permissions grid shows (Task 12) -- purely a display
// grouping, not a data-model concept.
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  // `registers.manage` sits with POS rather than Accounting because it is
  // exercised at the counter: opening a register for a colleague and signing off
  // their drawer count. Everyone with pos.access already opens and closes their
  // own — this is only the supervisory half.
  { label: 'POS', permissions: ['pos.access', 'registers.manage', 'discounts.apply', 'discounts.manual'] },
  { label: 'Inventory', permissions: ['inventory.view', 'inventory.edit'] },
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
      // With Accounting rather than in a bucket of their own: the ledger is a
      // tab of that screen, and a fifth group holding two permissions would
      // read as a fifth area of the app.
      'ledger.view',
      'ledger.manage',
      'dashboard.view',
      'settings.access',
    ],
  },
];

export function groupHasAny(permissions: readonly string[], group: { permissions: Permission[] }): boolean {
  return group.permissions.some((p) => permissions.includes(p));
}
