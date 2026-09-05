import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { formatCents } from '@/lib/currency';
import { StatementExport } from '@/components/accounting/ledger/statement-export';
import { useTabRefresh, type HeaderActionsSetter, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { type DateRange } from '@/components/range-selector';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { StatementEmpty, StatementHeading, StatementRow, type StatementVariant } from '@/components/ui/statement-row';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { extractErrorMessage } from '@/lib/checkout-errors';
import { toDateColumn } from '@/lib/period';
import { getCashFlow, hasFigures, type CashFlowLine } from '@/lib/statements';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The cash flow, indirect method — and the proof that it ties.
//
// Profit and cash are not the same thing, and the gap between them is the
// single most common way a profitable shop runs out of money. The statement
// starts at net profit and reasons its way to the movement in cash: that
// reasoning is what makes it useful, and it is also its whole risk, because
// every line is a delta and any one of them can carry the wrong sign while the
// report still reads plausibly.
//
// SO THE PROOF SECTION IS NOT DECORATION AND IS NEVER DROPPED TO SHORTEN THE
// SCREEN. `Movement in cash accounts` is the OBSERVED movement in
// 1000/1010/1020/1021, taken straight from the ledger and reached by no part of
// the arithmetic above it. Net change must equal it, and a sign slip anywhere
// lands there. A screen showing the reasoning without the proof proves nothing.
//
// THIS SCREEN DOES NO ARITHMETIC. Cash from operations, the two section totals,
// net change and the observed movement are all rows cash_flow() returned. In
// particular it does not subtract net change from the observed movement to see
// whether they agree — they are printed side by side and the reader compares
// them, which is what a proof is.

const STATEMENT_SECTIONS = ['operating', 'investing', 'financing', 'net_change'];

// How the exporter reads a line. Beside SECTION_HEADINGS because the two are
// one description of this statement's shape, and splitting them is how a new
// section gets a heading and no amount.
const STATEMENT_READ = {
  section: (row: { section: string }) => row.section,
  label: (row: { label: string }) => row.label,
  amount: (row: { amountCents: number }) => formatCents(row.amountCents),
  isTotal: (row: { isTotal: boolean }) => row.isTotal,
};

const SECTION_HEADINGS: Record<string, string> = {
  operating: 'Operating',
  investing: 'Investing',
  financing: 'Financing',
};

function variantFor(row: CashFlowLine): StatementVariant {
  // Two bottom lines, one per card: the statement's conclusion and the proof's.
  if (row.section === 'net_change') return 'total';
  if (row.isTotal) return row.section === 'proof' ? 'total' : 'emphasis';
  return 'item';
}

export function CashFlowView({ dateRange, setRefresh, setHeaderActions }: { dateRange: DateRange; setRefresh: RefreshSetter; setHeaderActions: HeaderActionsSetter }) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<CashFlowLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  // See income-statement-view.tsx for why the three statement screens carry an
  // error state and the six ledger views beside them do not: cash_flow() is
  // `security definer` and RAISES without `ledger.view` where a table read
  // under RLS would return nothing. Uncaught, that left the screen on
  // "Loading…" permanently.
  const [error, setError] = useState<string | null>(null);

  // Date COLUMNS, not Dates: `new Date(dateColumn)` parses as UTC midnight and
  // toDateColumn is the ledger screens' one place to get this right.
  const from = toDateColumn(dateRange.since);
  // `until` is optional and means "through today" — range-selector.tsx:22.
  const to = toDateColumn(dateRange.until ?? new Date());

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      setRows(await getCashFlow(shop.id, from, to));
      setError(null);
    } catch (err) {
      // The rows go with it. A statement left on screen beside a note saying it
      // could not be read gets read anyway.
      setRows([]);
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [shop, from, to]);

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

  const statement = useMemo(() => rows.filter((row) => STATEMENT_SECTIONS.includes(row.section)), [rows]);
  const proof = useMemo(() => rows.filter((row) => row.section === 'proof'), [rows]);

  // OVER THE STATEMENT ONLY, NEVER THE PROOF ROWS.
  //
  // "Cash at 31 Jul" and "Cash at 21 Aug" are absolute BALANCES, not
  // movements: a shop with $400 in the till that traded nothing this morning
  // has a completely flat cash flow and two proof rows reading $400. Tested
  // across all rows, `hasFigures` saw those two, called the statement
  // non-empty, and drew twelve lines of $0.00 -- which is precisely the wall of
  // zeroes the empty state exists to prevent, on the most ordinary morning a
  // shop has.
  //
  // The proof still renders whenever the statement does; this only decides
  // whether there is a statement to render at all.
  const anything = !error && hasFigures(statement);
  const headings = useMemo(() => {
    const seen = new Set<string>();
    return statement.map((row) => {
      if (seen.has(row.section)) return null;
      seen.add(row.section);
      return SECTION_HEADINGS[row.section] ?? null;
    });
  }, [statement]);

  if (!loaded || !anything) {
    return (
      <View style={styles.wrap}>
        <BentoCard title="Cash flow — indirect method" scope={rangeLabel}>
          {!loaded ? (
            <Text style={styles.loading}>Loading…</Text>
          ) : error ? (
            // 'partial', not 'wrong': nothing here is fixable by the reader,
            // and a 'wrong' caveat with no action trains people to skip them
            // all. The database's own message is shown as it arrived.
            <Caveat tone="partial">{error}</Caveat>
          ) : (
            <StatementEmpty>
              No cash moved in this window and nothing was posted against it, so there is no cash flow to draw. Sales,
              payments and bills post themselves — if the shop has been trading, try Post History.
            </StatementEmpty>
          )}
        </BentoCard>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <StatementExport
        setHeaderActions={setHeaderActions}
        rows={rows}
        title="Cash Flow"
        rangeLabel={rangeLabel}
        headings={SECTION_HEADINGS}
        read={STATEMENT_READ}
        filenamePrefix="cash-flow"
      />
      <BentoGrid>
        <BentoCell span={7}>
          <BentoCard title="Cash flow — indirect method" scope={rangeLabel}>
            {statement.map((row, index) => (
              <View key={`${row.sortOrder}-${row.label}`}>
                {headings[index] ? <StatementHeading>{headings[index]!}</StatementHeading> : null}
                <StatementRow label={row.label} amountCents={row.amountCents} variant={variantFor(row)} />
              </View>
            ))}
            {/* WHAT THE INVESTING LABEL CANNOT CARRY.
                'Equipment bought, less equipment sold' (20261007000100) names
                both halves, and there is one more thing to say that will not
                fit in a row label: "sold" means AT BOOK VALUE, not at the price
                it fetched. The difference between the two is the gain or the
                loss, and that is already inside Net profit at the top of this
                statement -- so a reader who looks for the sale price in the
                investing section and does not find it is looking in the right
                place for the wrong number.

                'context', not 'wrong': every figure above is correct and the
                statement proves out beside it. This explains a presentation,
                and there is nothing for the reader to do about it. */}
            <Caveat tone="context">
              Equipment sold appears in Investing at its book value — what it was still worth in the books — and not at
              the price it fetched. The difference between those two is the gain or loss on the sale, and that is
              already inside Net profit above.
            </Caveat>
          </BentoCard>
        </BentoCell>

        {/* Beside the statement, not under it. The proof is only a proof if the
            reader can hold it against the net change without scrolling. */}
        <BentoCell span={5}>
          <BentoCard title="Proof" scope="Observed in the ledger">
            {proof.map((row) => (
              <StatementRow key={`${row.sortOrder}-${row.label}`} label={row.label} amountCents={row.amountCents} variant={variantFor(row)} />
            ))}
            <Caveat tone="context">
              The movement above is read straight off the cash, bank and mobile-money accounts and is reached by no part
              of the statement beside it. It has to equal the net change. That is what makes an assembled statement
              checkable rather than merely plausible.
            </Caveat>
          </BentoCard>
        </BentoCell>
      </BentoGrid>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  loading: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 18, textAlign: 'center' },
});
