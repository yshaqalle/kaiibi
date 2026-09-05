import type { ReactElement } from 'react';

import { CategorySalesView } from '@/components/accounting/reports/category-sales-view';
import { EmployeeSalesView } from '@/components/accounting/reports/employee-sales-view';
import { InventoryBalanceView } from '@/components/accounting/reports/inventory-balance-view';
import { ItemPerformanceView } from '@/components/accounting/reports/item-performance-view';
import { LowStockView } from '@/components/accounting/reports/low-stock-view';
import type { ReportView } from '@/components/accounting/reports/reports-hub';
import { SalesReportView } from '@/components/accounting/reports/sales-report-view';
import { StockMovementView } from '@/components/accounting/reports/stock-movement-view';
import type { HeaderActionsSetter, RefreshSetter } from '@/components/accounting/use-header-actions';
import type { DateRange } from '@/components/range-selector';

// Which screen each catalogued report opens.
//
// A MAP RATHER THAN SEVEN `&&` LINES IN THE SHELL, and the difference is the
// whole reason this file exists. The shell's ledger routing is seven-plus
// conditional lines, and deleting one of them leaves a live hub card opening a
// blank body with the suite still green -- which happened, and which the
// ledger's nav test now guards by READING accounting.tsx as text and searching
// it for `view === 'assets'`. A grep cannot tell a live route from a dead one:
// it passes on a branch that renders the wrong component, on one commented
// out, and on the string appearing in a comment.
//
// The type below refuses the same mistake at compile time instead. `Record` over
// every routable ReportView means a screen removed here does not typecheck, and
// a report added to REPORT_VIEWS without a screen does not typecheck either --
// the two lists cannot drift apart, and nothing has to remember to check.
//
// `hub` and `statements` are excluded because neither is a report this map
// owns: the hub is the thing being routed FROM, and `statements` is the
// pre-existing Reports tab, which takes props none of these seven do.

export type ReportScreenProps = {
  dateRange: DateRange;
  locationFilter: string | null;
  setRefresh: RefreshSetter;
  /**
   * Where each report puts its Export buttons. It travels down because the
   * title row belongs to the shell and the rows belong to the screen -- the
   * same reason `setRefresh` does.
   */
  setHeaderActions: HeaderActionsSetter;
  /**
   * What the range picker is set to, for the export subtitle. The screens that
   * IGNORE the range do not take it: an export headed with a window the report
   * does not honour is the defect this whole prop exists to avoid.
   */
  rangeLabel: string | null;
};

/** Every report this hub routes to. Exhaustive, and checked by tsc. */
export const REPORT_SCREENS: Record<
  Exclude<ReportView, 'hub' | 'statements'>,
  (props: ReportScreenProps) => ReactElement
> = {
  sales: (p) => <SalesReportView dateRange={p.dateRange} locationFilter={p.locationFilter} setRefresh={p.setRefresh} setHeaderActions={p.setHeaderActions} rangeLabel={p.rangeLabel} />,
  item: (p) => <ItemPerformanceView dateRange={p.dateRange} locationFilter={p.locationFilter} setRefresh={p.setRefresh} setHeaderActions={p.setHeaderActions} rangeLabel={p.rangeLabel} />,
  employee: (p) => <EmployeeSalesView dateRange={p.dateRange} locationFilter={p.locationFilter} setRefresh={p.setRefresh} setHeaderActions={p.setHeaderActions} rangeLabel={p.rangeLabel} />,
  category: (p) => <CategorySalesView dateRange={p.dateRange} locationFilter={p.locationFilter} setRefresh={p.setRefresh} setHeaderActions={p.setHeaderActions} rangeLabel={p.rangeLabel} />,
  // These two take no range on purpose: stock on hand and a shortfall are
  // positions read at an instant, not windows, and their hub cards say "As of
  // today" rather than promising a window the screen does not keep. They still
  // take the store filter -- which shelf is empty is a real question.
  inventory: (p) => <InventoryBalanceView locationFilter={p.locationFilter} setRefresh={p.setRefresh} setHeaderActions={p.setHeaderActions} />,
  lowstock: (p) => <LowStockView locationFilter={p.locationFilter} setRefresh={p.setRefresh} setHeaderActions={p.setHeaderActions} />,
  movement: (p) => <StockMovementView dateRange={p.dateRange} locationFilter={p.locationFilter} setRefresh={p.setRefresh} setHeaderActions={p.setHeaderActions} rangeLabel={p.rangeLabel} />,
};

/** True for a report view this map can render -- so not the hub, not the legacy tab. */
export function hasReportScreen(view: ReportView): view is Exclude<ReportView, 'hub' | 'statements'> {
  return view !== 'hub' && view !== 'statements';
}
