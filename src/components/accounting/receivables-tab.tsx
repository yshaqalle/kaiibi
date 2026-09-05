import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { AgingStrip } from '@/components/accounting/aging-strip';
import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { WhatsAppButton } from '@/components/whatsapp-button';
import { TABLET_BREAKPOINT } from '@/constants/layout';
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
  groupByCustomer,
  pastDueLabel,
  remindedLabel,
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
// sits here too. That row still says "14 days late" under its due date in the
// table below, so nothing is hidden -- it is simply not bucketed on its own.
// The hint says exactly that rather than the friendlier and untrue "not yet
// due".
const PAST_DUE_HINTS: Record<AgingBucket, string> = {
  current: 'under 30 days past due',
  d30: 'a month past due',
  d60: 'two months past due',
  d90: 'three months or more',
};

/**
 * Narrow enough that the whole row fits a phone, so the reminder button is
 * never off-screen.
 *
 * DataTable defaults to 560 and scrolls sideways below it rather than crushing
 * its columns -- a good default for a wide ledger, and the reason this table
 * has always overflowed a phone. That was tolerable while the rightmost column
 * was another figure. It stopped being tolerable when the rightmost column
 * became the button that sends the reminder: an ACTION hidden behind a sideways
 * swipe, with nothing on screen suggesting the swipe exists, is an action most
 * people will never find.
 *
 * 70 + 84 + 42 of fixed columns leaves the customer name 100px here, and the
 * name is the right thing to squeeze: it truncates gracefully and it is the one
 * column that grows again on a wider screen, where `flex: 1` hands it every
 * spare pixel.
 *
 * The number was measured, not guessed, and measured TWICE -- 340 still clipped
 * the button on an iPhone 16 Pro, because the card is narrower on the device
 * than the browser at the same nominal width. This leaves real headroom rather
 * than shaving it fine.
 *
 * ONLY on a phone, though. DataTable's inner view sizes to its content, so a
 * 296px minimum on a 1300px card leaves the table hugging the left with a
 * thousand pixels of dead space beside it -- which is what happened when this
 * was one flat number. Above the tablet breakpoint the old 560 is kept: there
 * is width to spare there, nothing is at risk of being clipped, and the table
 * fills the card as it always has.
 */
const TABLE_MIN_WIDTH_PHONE = 296;
const TABLE_MIN_WIDTH_WIDE = 560;

/**
 * The due date and how late it is, as ONE cell.
 *
 * It was two columns plus a badge, and on a device that did not fit: with five
 * columns the REMIND button sat off the right edge of an iPhone AND an 11-inch
 * iPad -- reachable only by discovering that the table scrolls sideways, which
 * is not a thing to ask of the one control that makes the feature worth having.
 *
 * Collapsing them is not just a width fix. "Due Sep 5", a "Late" badge and a
 * "34 days" column are three encodings of one fact; the second line below says
 * the same thing in fewer places and reads as a sentence -- "Sep 5 / 34 days
 * late". The number carries the signal and the colour only reinforces it, which
 * is the rule the old badge already followed.
 */
function DueCell({ dueOn, today }: { dueOn: string | null; today: Date }) {
  // ONE source for whether this is late. An earlier version asked twice --
  // `dueStatus(...)` for the wording and `daysPastDue(...) > 0` for the colour
  // -- which is two implementations of the same question sitting four lines
  // apart, and the kind of pair that eventually disagrees on a boundary.
  const status = dueStatus(dueOn, today);
  const late = status === 'late';
  return (
    <View style={styles.dueCell}>
      <Text style={[styles.dueDate, late && styles.dueDateLate]} numberOfLines={1}>
        {dueOn ? fromDateColumn(dueOn).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—'}
      </Text>
      {dueOn ? (
        <Text style={[styles.dueMeta, late && styles.dueMetaLate]} numberOfLines={1}>
          {/* All three readings together, because they are one sentence in
              three moods and reading them apart is how they drift. */}
          {late ? `${pastDueLabel(dueOn, today)} late` : status === 'soon' ? 'Due soon' : 'not yet due'}
        </Text>
      ) : null}
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
      // Fixed rather than flexed, along with the two columns after it. Only the
      // customer name benefits from spare width; money, a date and a 34px
      // button do not, and leaving all four to `flex: 1` is what pushed the
      // button off the edge (see TABLE_MIN_WIDTH_PHONE).
      width: 70,
      render: (row) => <ValueCell value={formatCents(row.owedCents)} strong />,
    },
    {
      key: 'due',
      header: 'Due',
      numeric: true,
      width: 84,
      render: (row) => <DueCell dueOn={row.dueOn} today={today} />,
    },
    {
      key: 'remind',
      // Blank, like every other action column here (close-period-view,
      // fixed-assets-view). "Remind" does not fit 42px and rendered as "RE…",
      // which labels nothing and reads as a bug. The button carries its own
      // description for screen readers -- "Remind Amina about $7.69 on
      // WhatsApp" -- so the heading was never what made it findable.
      header: '',
      width: 42,
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
  const { width } = useWindowDimensions();
  const tableMinWidth = width >= TABLET_BREAKPOINT ? TABLE_MIN_WIDTH_WIDE : TABLE_MIN_WIDTH_PHONE;
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
            minWidth={tableMinWidth}
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
  // Right-aligned to sit with the numeric columns beside it, and stacked so the
  // date and its lateness read as one answer rather than two cells.
  dueCell: { alignItems: 'flex-end' },
  dueDate: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  // Amber rather than red, for the same reason the 90+ tile is amber: money
  // owed late is a task, not a loss. The words beneath say "late" either way,
  // so the colour is never the only signal.
  dueDateLate: { color: theme.bentoWarn },
  dueMeta: { fontSize: 10.5, fontWeight: '600', color: theme.bentoMuted2, marginTop: 1 },
  dueMetaLate: { color: theme.bentoWarn },
});
