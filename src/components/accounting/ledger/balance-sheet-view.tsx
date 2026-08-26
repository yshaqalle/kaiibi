import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { type DateRange } from '@/components/range-selector';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { StatementEmpty, StatementHeading, StatementRow, type StatementVariant } from '@/components/ui/statement-row';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatAccountingCents } from '@/lib/currency';
import { fromDateColumn, toDateColumn } from '@/lib/period';
import { getBalanceSheet, hasFigures, type StatementLine } from '@/lib/statements';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The balance sheet: what the shop owns, what it owes, and what is left over.
//
// AS AT ONE DATE, NOT OVER A RANGE. There is no such thing as a balance sheet
// "for the last 7 days" — it is a position, read at an instant. The shell hands
// every ledger screen the shared window, and this one takes its END and ignores
// the start. That is why the hub card says "As of today" rather than "7 days".
//
// THIS SCREEN DOES NO ARITHMETIC. Every subtotal, both grand totals and the
// profit-this-period line are rows balance_sheet() returned. It does not even
// subtract one side from the other to check they match: the equality is a
// consequence of every entry balancing, which is a property of the database,
// and a screen that "checked" it would be inventing a test that cannot fail
// while implying one that can.

// The two halves of the sheet, and the order the sections read in down each.
const ASSET_SECTIONS = ['current_assets', 'fixed_assets', 'total_assets'];
const CLAIM_SECTIONS = ['liabilities', 'equity', 'total_liabilities_equity'];

const SECTION_HEADINGS: Record<string, string> = {
  current_assets: 'Current assets',
  fixed_assets: 'Fixed assets',
  liabilities: 'Current liabilities',
  equity: 'Equity',
};

// The two grand totals, which are the figures the sheet exists to show side by
// side. Everything else is emphasis.
const GRAND_TOTALS = ['total_assets', 'total_liabilities_equity'];

function variantFor(row: StatementLine): StatementVariant {
  if (GRAND_TOTALS.includes(row.section)) return 'total';
  if (row.isTotal) return 'emphasis';
  return 'sub';
}

/** The rows of one half, in the order the function returned them. */
function half(rows: StatementLine[], sections: string[]): StatementLine[] {
  return rows.filter((row) => sections.includes(row.section));
}

function headingsFor(rows: StatementLine[]): (string | null)[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    if (row.isTotal) return null;
    if (seen.has(row.section)) return null;
    seen.add(row.section);
    return SECTION_HEADINGS[row.section] ?? null;
  });
}

function Side({ title, scope, rows }: { title: string; scope: string; rows: StatementLine[] }) {
  const headings = headingsFor(rows);
  return (
    <BentoCard title={title} scope={scope}>
      {rows.map((row, index) => (
        <View key={`${row.sortOrder}-${row.code ?? row.label}`}>
          {headings[index] ? <StatementHeading>{headings[index]!}</StatementHeading> : null}
          <StatementRow label={row.label} amountCents={row.amountCents} variant={variantFor(row)} />
        </View>
      ))}
    </BentoCard>
  );
}

export function BalanceSheetView({ dateRange, setRefresh }: { dateRange: DateRange; setRefresh: RefreshSetter }) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<StatementLine[]>([]);
  const [loaded, setLoaded] = useState(false);

  // The END of the window, and only the end. `until` is optional and means
  // "through today" — range-selector.tsx:22. toDateColumn, not toISOString:
  // the latter converts to UTC first, so an evening query west of Greenwich
  // would ask for tomorrow.
  const asOf = toDateColumn(dateRange.until ?? new Date());

  const reload = useCallback(async () => {
    if (!shop) return;
    setRows(await getBalanceSheet(shop.id, asOf));
    setLoaded(true);
  }, [shop, asOf]);

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

  // fromDateColumn, never `new Date(asOf)`: a date-only string parses as UTC
  // midnight and renders a day early for every reader west of Greenwich.
  const scope = `As at ${fromDateColumn(asOf).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const anything = hasFigures(rows);

  const assets = useMemo(() => half(rows, ASSET_SECTIONS), [rows]);
  const claims = useMemo(() => half(rows, CLAIM_SECTIONS), [rows]);
  // READ, not computed. The caveat quotes the figure the function returned for
  // total assets; it does not add the sides up to see whether they agree.
  const totalAssets = rows.find((row) => row.section === 'total_assets');

  if (!loaded || !anything) {
    return (
      <View style={styles.wrap}>
        <BentoCard title="Balance sheet" scope={scope}>
          {!loaded ? (
            <Text style={styles.loading}>Loading…</Text>
          ) : (
            <StatementEmpty>
              Nothing has been posted as at this date, so there is no balance sheet to draw. Sales, deliveries and bills
              post themselves — if the shop has been trading, try Post History.
            </StatementEmpty>
          )}
        </BentoCard>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {/* Side by side is the whole point: the two halves are one figure read
          twice, and stacking them puts a scroll between the pair. */}
      <BentoGrid>
        <BentoCell span={6}>
          <Side title="Assets" scope={scope} rows={assets} />
        </BentoCell>
        <BentoCell span={6}>
          <Side title="Liabilities &amp; equity" scope={scope} rows={claims} />
        </BentoCell>
      </BentoGrid>

      {/* `context`, and no action. The number is right; this says why the two
          sides being identical is not a coincidence. A `wrong` here — or a
          `context` carrying a button — would train readers to skip the whole
          family. */}
      <Caveat tone="context">
        {`${totalAssets ? formatAccountingCents(totalAssets.amountCents) : 'The same figure'} on both sides. That equality is not a check run after the fact — it is a consequence of every entry balancing, which the database refuses to let an entry do otherwise. It is the first thing an accountant looks for.`}
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  loading: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 18, textAlign: 'center' },
});
