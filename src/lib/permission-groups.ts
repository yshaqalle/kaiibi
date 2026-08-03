import type { Permission } from '@/lib/permissions';

// Groups the permission catalog into the 4 buckets the Team detail pane's
// read-only Access & permissions grid shows (Task 12) -- purely a display
// grouping, not a data-model concept.
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: 'POS', permissions: ['pos.access'] },
  { label: 'Inventory', permissions: ['inventory.view', 'inventory.edit'] },
  {
    label: 'People',
    permissions: ['customers.view', 'customers.edit', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view'],
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
