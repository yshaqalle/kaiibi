import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AgingStrip } from '@/components/accounting/aging-strip';
import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { WhatsAppButton } from '@/components/whatsapp-button';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { listOutstanding, type CustomerBalance } from '@/lib/balances';
import { agingTotals, inBucket, type AgingBucket } from '@/lib/aging';
import { markReminded } from '@/lib/customers';
import { fromDateColumn } from '@/lib/period';
import { buildReminderText } from '@/lib/reminder';
import {
  agingDaysFor,
  daysPastDue,
  dueStatus,
  DUE_STATUS_LABELS,
  groupByCustomer,
  pastDueLabel,
  remindedLabel,
  type DueStatus,
  type Receivable,
} from '@/lib/receivables';
import { formatCents, formatCompactCents } from '@/lib/currency';

const theme = Colors.light;

// The aging strip on THIS tab measures days past due, where the Bills tab
// measures days since a bill was issued. src/lib/aging.ts is shared and takes
// whatever accessor it is given, so the boundaries and the reconciliation are
// identical for both -- but the hints it ships are written for the bill sense
// and would be wrong here. Relabelled after the fact rather than parameterised,
// which keeps aging.ts's arithmetic untouched for both callers.
//
// "Current" is the one worth reading carefully. It is NOT "not yet due": the
// buckets put everything under thirty days in it, so a debt a fortnight late
// sits here too. That row still carries a Late badge and a "14 days" past-due
// figure in the table below, so nothing is hidden -- it is simply not bucketed
// on its own. The hint says exactly that rather than the friendlier and untrue
// "not yet due".
const PAST_DUE_HINTS: Record<AgingBucket, string> = {
  current: 'under 30 days past due',
  d30: 'a month past due',
  d60: 'two months past due',
  d90: 'three months or more',
};

/** The badge beside a due date. Words carry it; the colour only reinforces. */
function DueBadge({ status }: { status: DueStatus }) {
  return (
    <View style={styles.badge}>
      <Text style={[styles.badgeText, status === 'late' && styles.badgeTextLate]}>
        {DUE_STATUS_LABELS[status]}
      </Text>
    </View>
  );
}

// Built for a fixed clock rather than reading Date.now() while rendering. Two
// reasons, and the lint rule is the lesser: an impure render can print a
// different age for the same row on a re-render, and a table whose "Past due"
// column ticks over mid-scroll is worse than one that is a few seconds stale.
function buildColumns(
  today: Date,
  now: number,
  renderRemind: (row: Receivable) => React.ReactNode
): Column<Receivable>[] {
  return [
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => (
        <NameCell
          title={row.customerName || 'Unnamed customer'}
          // Two facts compete for one line. The reminder wins when there is
          // one: "3 unpaid sales" is a detail of the debt, while "Reminded
          // yesterday" is the thing that stops a second person ringing.
          meta={
            remindedLabel(row.lastRemindedAt, now) ??
            (row.saleCount > 1 ? `${row.saleCount} unpaid sales` : undefined)
          }
        />
      ),
    },
    {
      key: 'owed',
      header: 'Owed',
      numeric: true,
      render: (row) => <ValueCell value={formatCents(row.owedCents)} strong />,
    },
    {
      key: 'due',
      header: 'Due',
      numeric: true,
      render: (row) => {
        const status = dueStatus(row.dueOn, today);
        return (
          <View style={styles.dueCell}>
            <ValueCell
              value={
                row.dueOn
                  ? fromDateColumn(row.dueOn).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                  : '—'
              }
              tone={status === 'late' ? 'warning' : 'muted'}
            />
            {status ? <DueBadge status={status} /> : null}
          </View>
        );
      },
    },
    {
      key: 'pastDue',
      header: 'Past due',
      numeric: true,
      render: (row) => (
        // The number carries the signal and the colour reinforces it, never the
        // other way round -- "not yet" and "34 days" read differently in mono.
        <ValueCell
          value={pastDueLabel(row.dueOn, today)}
          tone={daysPastDue(row.dueOn, today) > 0 ? 'warning' : 'muted'}
        />
      ),
    },
    {
      key: 'remind',
      header: 'Remind',
      width: 60,
      // Renders nothing for a customer with no dialable number, which is
      // WhatsAppButton's own rule: offering to message somebody and then
      // opening an empty chat is worse than not offering.
      render: renderRemind,
    },
  ];
}

export function ReceivablesTab({
  setRefresh,
  initialBucket = null,
}: {
  setRefresh: RefreshSetter;
  /**
   * Set by the Reports hub's Aging Receivables card, which opens this tab with
   * a bucket already chosen. The card is the report; this tab is where it runs.
   */
  initialBucket?: AgingBucket | null;
}) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<CustomerBalance[]>([]);
  // The clock these ages are measured against, stamped when the rows arrived.
  // Zero until then, which reads as "today" -- and there are no rows to age yet.
  const [readAt, setReadAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      setRows(await listOutstanding(shop.id));
      setReadAt(Date.now());
      setError(null);
    } catch {
      // Said rather than shown as an empty list: "nobody owes you anything" and
      // "this did not load" look identical otherwise, and only one of them is
      // good news.
      setError('Could not load what is outstanding. Pull to refresh.');
    }
  }, [shop]);

  // The initial fetch. useRefreshOnFocus deliberately skips the focus that
  // arrives with mounting and documents this effect as the thing that does it --
  // so every accounting tab carries the same one, and the same lint complaint.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const receivables = useMemo(() => groupByCustomer(rows), [rows]);
  const [bucket, setBucket] = useState<AgingBucket | null>(initialBucket);

  // One Date for the whole render pass, derived from the same stamp the table
  // uses, so a row cannot sit in one bucket and print a past-due figure from
  // another.
  //
  // `readAt` of 0 is carried straight through rather than falling back to the
  // wall clock, for the reason the state above gives: there are no rows to age
  // until the read lands, so the epoch is never actually shown to anybody --
  // and reading the clock here would be an impure call in render, which is the
  // whole thing this fixed stamp exists to avoid.
  const today = useMemo(() => new Date(readAt), [readAt]);

  // THE ONE LINE THAT REPOINTS THE STRIP. It was daysOwed(row.oldestAt) --
  // days since the sale. aging.ts never knew where the number came from, so
  // this is the whole of the change there.
  const ageOf = useCallback((row: Receivable) => agingDaysFor(row, today), [today]);
  const buckets = useMemo(
    () =>
      agingTotals(receivables, { days: ageOf, cents: (r) => r.owedCents }).map((total) => ({
        ...total,
        hint: PAST_DUE_HINTS[total.key],
      })),
    [receivables, ageOf]
  );
  const shown = useMemo(() => inBucket(receivables, bucket, ageOf), [receivables, bucket, ageOf]);

  /**
   * Record that this customer was chased. The message itself is opened by
   * WhatsAppButton; this is only the memory of it.
   *
   * The row is patched in place rather than refetched: a full reload of the
   * outstanding query to make one word change is a visible stutter, and the
   * stamp we write is the stamp the server now holds.
   *
   * A failure here is deliberately silent. The WhatsApp draft is already open
   * on top of this screen -- the shopkeeper is looking at their message, not at
   * us -- and an error toast about bookkeeping they did not ask for, over a
   * conversation they are mid-way through, would be noise about the least
   * important half of what just happened.
   */
  const recordReminder = useCallback(async (row: Receivable) => {
    try {
      const stamp = await markReminded(row.customerId);
      setRows((prev) =>
        prev.map((r) => (r.customerId === row.customerId ? { ...r, lastRemindedAt: stamp } : r))
      );
    } catch {
      // Intentionally ignored -- see above.
    }
  }, []);

  const renderRemind = useCallback(
    (row: Receivable) => {
      const name = row.customerName || 'Unnamed customer';
      return (
        <WhatsAppButton
          phone={row.customerPhone}
          name={name}
          accessibilityLabel={`Remind ${name} about ${formatCents(row.owedCents)} on WhatsApp`}
          message={buildReminderText(shop?.reminderTemplate, {
            customer: name,
            shop: shop?.name ?? '',
            amount: formatCents(row.owedCents),
            // The long month, unlike the table's "2 Aug". This is read once, in
            // a sentence, by somebody who is not looking at a column.
            due: row.dueOn
              ? fromDateColumn(row.dueOn).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
              : '',
          })}
          onOpened={() => { recordReminder(row); }}
        />
      );
    },
    [shop, recordReminder]
  );

  const columns = useMemo(() => buildColumns(today, readAt, renderRemind), [today, readAt, renderRemind]);

  const totalCents = receivables.reduce((sum, row) => sum + row.owedCents, 0);
  const overdue = receivables.filter((row) => daysPastDue(row.dueOn, today) > 0);
  const overdueCents = overdue.reduce((sum, row) => sum + row.owedCents, 0);

  return (
    <View style={styles.body}>
      <BentoCard title="Owed to the shop" scope="right now">
        <View style={styles.metricRow}>
          <StatTile
            value={formatCompactCents(totalCents)}
            label="Owed to you"
            hint={receivables.length === 1 ? 'from 1 customer' : `from ${receivables.length} customers`}
            variant="bento"
          />
          {/* Was "Over 30 days", counting age. Now money rather than a count,
              and lateness rather than age: "$1,650 past due" is the figure a
              shop acts on, where "2 customers" made the reader open the table
              to find out whether it mattered. */}
          <StatTile
            value={formatCompactCents(overdueCents)}
            label="Past due"
            hint={
              overdue.length === 0
                ? 'nothing is late'
                : overdue.length === 1
                  ? 'from 1 customer, worth a call'
                  : `from ${overdue.length} customers, worth a call`
            }
            tone={overdue.length > 0 ? 'warning' : 'default'}
            variant="bento"
          />
        </View>

        {/* The specific misunderstanding to prevent: an owner reading this as
            money still to come IN on top of what they have already earned. It is
            not a forecast -- every cent of it was recognised as revenue on the
            day the goods left the shop. `context` because the figure is right
            and there is nothing to fix. */}
        <Caveat tone="context">
          Already counted as revenue on the day of the sale, not income still to come. This is how much of
          it is sitting with customers rather than in the till.
        </Caveat>

        {/* Also `context`: the dates are right to age by and there is nothing
            to correct, but a shopkeeper who reads "due 2 Aug" on a sale from
            before this existed should know nobody agreed that date with the
            customer. Saying so once here is cheaper than a footnote per row. */}
        <Caveat tone="context">
          Sales made before due dates existed were given one thirty days after the sale, so the whole
          column measures the same thing. For those, the date is derived rather than agreed with the
          customer.
        </Caveat>
      </BentoCard>

      {/* Out of any grid: a collections list is read down a column, and a table
          in a half-width cell loses its gutters for nothing. */}
      <BentoCard title="How late the money is" scope="right now">
        <AgingStrip totals={buckets} selected={bucket} onSelect={setBucket} />
      </BentoCard>

      <BentoCard
        title={bucket ? `Who owes what · ${buckets.find((b) => b.key === bucket)?.label}` : 'Who owes what'}
        bodyStyle={styles.tableBody}
      >
        {error ? (
          <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => { reload(); } }}>
            {error}
          </Caveat>
        ) : (
          <DataTable
            columns={columns}
            rows={shown}
            keyExtractor={(row) => row.customerId}
            emptyLabel={bucket ? 'Nothing in this bucket.' : 'Nobody owes the shop anything.'}
          />
        )}
      </BentoCard>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  // 10, not the card's usual 18: the table brings its own gutters.
  tableBody: { paddingHorizontal: 10 },
  dueCell: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  // 999 is the house pill radius (tab-pills, delta-badge, the card scope pill).
  badge: {
    backgroundColor: theme.bentoSoft,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  // Both badges sit on the same soft surface and differ in ink, because there
  // is no warn WASH token -- only bentoWarn itself. Inventing one would mean
  // guessing a contrast ratio for a pair that every other wash in theme.ts
  // documents precisely, for a 10px pill that already carries its meaning in
  // the word inside it. Amber rather than red for the same reason the 90+ tile
  // is amber: money owed late is a task, not a loss.
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3, color: theme.bentoMuted },
  badgeTextLate: { color: theme.bentoWarn },
});
