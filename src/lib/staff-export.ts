import type { CsvColumn } from '@/lib/csv';
import { formatCents } from '@/lib/currency';
import { payRateUnitLabel } from '@/lib/pay-rate';
import type { StaffMember } from '@/types/models';

// The team CSV export. Lives here rather than in people.tsx because it has a
// contract with staff-import.ts that a screen file can't state and no test
// could reach: export a roster, edit it in a spreadsheet, import it back.
//
// Which is why the first column is 'Full Name' and not 'Name'. As 'Name' the
// export was missing a column STAFF_TEMPLATE_COLUMNS marks required, so the
// picker refused an exported roster outright -- "Missing required column: Full
// Name" -- and the round trip the pay columns below were written for could
// never happen. See the round-trip test, which now holds the two files to that
// contract.
//
// The extra columns (Status, Hire Date, Stores) are ignored by the import
// rather than rejected, which is what lets the export stay a readable roster
// report as well as an importable file.
export const TEAM_EXPORT_COLUMNS_BASIC: CsvColumn<StaffMember>[] = [
  { header: 'Full Name', value: (m) => m.fullName ?? '' },
  { header: 'Email', value: (m) => m.email ?? '' },
  { header: 'Phone', value: (m) => m.phone ?? '' },
  { header: 'Role', value: (m) => m.roleName },
  { header: 'Status', value: (m) => (m.active ? 'Active' : 'Disabled') },
  { header: 'Hire Date', value: (m) => m.hireDate ?? '' },
];

export const TEAM_EXPORT_COLUMNS_WITH_PAY: CsvColumn<StaffMember>[] = [
  ...TEAM_EXPORT_COLUMNS_BASIC,
  { header: 'Pay Type', value: (m) => m.payType ?? '' },
  { header: 'Pay Rate', value: (m) => (m.payRateCents != null ? formatCents(m.payRateCents) : '') },
  // The file leaves the app and loses every bit of context that would
  // otherwise say what the number means, so the unit travels with it.
  { header: 'Pay Rate Unit', value: (m) => payRateUnitLabel(m.payType) },
  { header: 'Pay Cadence', value: (m) => m.payCadence },
];
