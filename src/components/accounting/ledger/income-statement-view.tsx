import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { type DateRange } from '@/components/range-selector';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { StatementEmpty, StatementHeading, StatementRow, type StatementVariant } from '@/components/ui/statement-row';
import { TabPills } from '@/components/ui/tab-pills';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { toDateColumn } from '@/lib/period';
import { hasFigures, listStatementLines, type StatementLine } from '@/lib/statements';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The income statement — Profit & Loss and Income Statement being the same
// report at two grains, which is why there is one screen with a toggle rather
// than two entries on the hub.
//
// THIS SCREEN DOES NO ARITHMETIC. Net revenue, gross profit, total operating
// expenses and net profit are all rows statement_lines() returned, printed as
// they arrived. A screen that summed its own rows would be a second
// implementation of the statement, and the two would disagree the first time an
// account type or a rounding rule changed — with nobody able to say which was
// right. See trial-balance-view.tsx, which works the same way.
//
// It does not flip any signs either. statement_lines() already renders its
// figures in PRESENTATION sign — income positive, costs positive — precisely so
// a screen does not have to think about the ledger's debit-positive convention.
// Negating a cost line here would flip it a second time.

const DETAIL_OPTIONS: { key: 'summary' | 'detail'; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'detail', label: 'Every account' },
];

// The heading above a block of per-account rows. Only three sections ever carry
// them — the other two (`gross_profit`, `net_profit`) are single subtotal lines
// with no accounts beneath them.
const SECTION_HEADINGS: Record<string, string> = {
  revenue: 'Revenue',
  cost_of_sales: 'Cost of sales',
  operating_expenses: 'Operating expenses',
};

// The DEFINITION of each figure, which is exactly where an argument about a
// number starts. Keyed by section rather than by label so a wording change in
// the migration cannot silently drop them.
const SECTION_HINTS: Record<string, string> = {
  revenue: "excludes sales tax — that's owed, not earned",
  cost_of_sales: 'what the items sold cost you, including shrinkage',
  operating_expenses: 'excludes stock purchases and owner draws',
};

function variantFor(row: StatementLine): StatementVariant {
  // The bottom line, and the only row on the card that gets the filled panel.
  if (row.section === 'net_profit') return 'total';
  if (row.isTotal) return 'emphasis';
  return 'sub';
}

export function IncomeStatementView({ dateRange, setRefresh }: { dateRange: DateRange; setRefresh: RefreshSetter }) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<StatementLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState(false);

  // Date COLUMNS, not Dates: `new Date(dateColumn)` parses as UTC midnight and
  // toDateColumn is the ledger screens' one place to get this right. They are
  // also plain strings, so the useCallback below re-runs on a real change of
  // window rather than on every render.
  const from = toDateColumn(dateRange.since);
  // `until` is optional and means "through today" — range-selector.tsx:22.
  const to = toDateColumn(dateRange.until ?? new Date());

  const reload = useCallback(async () => {
    if (!shop) return;
    setRows(await listStatementLines(shop.id, from, to, detail));
    setLoaded(true);
  }, [shop, from, to, detail]);

  // See the note in chart-of-accounts-view.tsx: use-refresh-on-focus does not
  // fetch on the mounting focus, and depends on this effect having done it.
  //
  // The rule reads `reload` as a synchronous setState because its body contains
  // one. It does not: every setState above sits after an `await`, which is the
  // promise callback the rule's own guidance asks for. Suppressed here rather
  // than restructured, because restructuring would give these three screens a
  // different loading shape from the six ledger views beside them.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const rangeLabel = formatRangeLabel(dateRange);
  const anything = hasFigures(rows);

  // Which rows open a block of per-account lines, so the heading is drawn once
  // above the first of them. Precomputed rather than worked out inside the map,
  // which would be quadratic and would read as if the order mattered to it.
  const headingAt = useMemo(() => {
    const seen = new Set<string>();
    return rows.map((row) => {
      if (row.code === null) return null;
      if (seen.has(row.section)) return null;
      seen.add(row.section);
      return SECTION_HEADINGS[row.section] ?? null;
    });
  }, [rows]);

  return (
    <View style={styles.wrap}>
      {/* The two grains of one report. Not two hub cards: built as two reports
          they would eventually disagree, and nobody would know which was
          right. */}
      <View style={styles.toggle}>
        <TabPills options={DETAIL_OPTIONS} value={detail ? 'detail' : 'summary'} onChange={(key) => setDetail(key === 'detail')} />
      </View>

      <BentoCard title="Profit &amp; loss" scope={rangeLabel}>
        {!loaded ? (
          <Text style={styles.loading}>Loading…</Text>
        ) : !anything ? (
          <StatementEmpty>
            Nothing has been posted in this window, so there is no income statement to draw. Sales, refunds and bills
            post themselves — if the shop has been trading, try Post History.
          </StatementEmpty>
        ) : (
          rows.map((row, index) => (
            <View key={`${row.sortOrder}-${row.code ?? row.label}`}>
              {headingAt[index] ? <StatementHeading>{headingAt[index]!}</StatementHeading> : null}
              <StatementRow
                label={row.label}
                hint={row.isTotal ? SECTION_HINTS[row.section] : undefined}
                amountCents={row.amountCents}
                variant={variantFor(row)}
              />
            </View>
          ))
        )}
      </BentoCard>

      {anything ? (
        <Caveat tone="context">
          Costs are shown as positive figures because that is how the books hand them over, already turned the right way
          up for reading. Stock purchases and owner draws are not on this statement at all: stock sits in Inventory until
          it sells, and a draw is equity. Both are on the balance sheet instead.
        </Caveat>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  toggle: { alignSelf: 'flex-start' },
  loading: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 18, textAlign: 'center' },
});
