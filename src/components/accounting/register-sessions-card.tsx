import { StyleSheet, Text, View } from 'react-native';

import { ListCard } from '@/components/ui/list-card';
import { Colors } from '@/constants/theme';
import { formatCents, formatForeignCents } from '@/lib/currency';
import { BASE_CURRENCY, formatSessionWindow, varianceTone } from '@/lib/register-sessions';
import type { Currency, RegisterSession } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Every register session, in Accounting → Cash & Budgets.
//
// This is the INVESTIGATION surface, which is why it is complete and
// deliberately unexciting: every session in order, balanced ones included. The
// Dashboard shows only the drawers that missed, because its job is "what needs
// attention right now"; this one answers "what happened", and a list that hid
// the clean sessions could not answer it.
//
// It sits in Cash & Budgets because that tab already owns where the shop's
// money physically is — `cash_accounts` lives here, and its own migration
// comment (20260804000500) asks "whose float, which drawer of the two".
//
// Every figure shown is FROZEN as it was signed off. A later refund or sale
// edit must not rewrite a drawer count somebody put their name to, which is why
// nothing here is recomputed from live rows.

export type SessionRow = {
  session: RegisterSession;
  registerName: string;
  personName: string;
  // What it rang up, across every tender. Present for open sessions too — "how
  // is this till doing?" is a different question from "does the drawer add up?",
  // and only the second one waits for a close.
  saleCount: number;
  takenCents: number;
};

export function RegisterSessionsCard({
  rows,
  currencies,
}: {
  rows: SessionRow[];
  currencies: Currency[];
}) {
  const outOfBalance = rows.filter(
    (row) => row.session.closedAt && (row.session.varianceBaseCents ?? 0) !== 0
  ).length;

  return (
    <ListCard
      title="Register sessions"
      // Counts the exceptions, not the total: "18 sessions" says nothing a
      // reader needs, while "2 out of balance" is the reason to open the card.
      scope={outOfBalance === 0 ? 'All balanced' : `${outOfBalance} out of balance`}
      rows={rows}
      keyExtractor={(row) => row.session.id}
      renderRow={(row) => <SessionRowView row={row} currencies={currencies} />}
      emptyLabel="No register has been opened in this period."
      previewCount={4}
      // ListCard renders `note` bare inside the card body, so it must be an
      // element — a plain string lands as a text node inside a View and React
      // Native refuses it.
      note={
        <Text style={styles.cardNote}>
          Counted figures and variances are frozen as they were signed off — a later refund or edit never rewrites
          them.
        </Text>
      }
    />
  );
}

function SessionRowView({ row, currencies }: { row: SessionRow; currencies: Currency[] }) {
  const { session } = row;
  const open = !session.closedAt;
  const variance = session.varianceBaseCents ?? 0;
  const tone = varianceTone(variance);

  // A session that took no cash at all — a phone seller on mobile money — has
  // nothing to reconcile, and showing it a "$0.00 balanced" would imply a
  // drawer was counted when none exists.
  const nothingToCount = !open && session.cash.length === 0;

  const counted = session.cash
    .filter((cash) => cash.closingCountedMinor != null)
    .map((cash) => formatMinor(cash.closingCountedMinor ?? 0, cash.currencyCode, currencies));
  const floats = session.cash
    .filter((cash) => cash.openingFloatMinor > 0)
    .map((cash) => formatMinor(cash.openingFloatMinor, cash.currencyCode, currencies));

  const meta = [
    formatSessionWindow(session.openedAt),
    // Takings first, because it is the line someone scans for. Shown for a
    // session that has rung nothing too — "0 sales" on an open register is
    // itself worth seeing.
    `${row.saleCount === 1 ? '1 sale' : `${row.saleCount} sales`} · ${formatCents(row.takenCents)}`,
    open
      ? floats.length > 0
        ? `float ${floats.join(' + ')}`
        : 'no float'
      : counted.length > 0
        ? `counted ${counted.join(' + ')}`
        : null,
  ].filter(Boolean);

  return (
    <View style={styles.row}>
      <View style={styles.body}>
        <Text style={styles.title}>
          {row.registerName} · {row.personName}
        </Text>
        <Text style={styles.meta}>{meta.join(' · ')}</Text>
        {session.closingNote ? <Text style={styles.note}>{session.closingNote}</Text> : null}
      </View>
      <View style={styles.tail}>
        {open ? (
          <>
            <Text style={[styles.value, { color: theme.bentoProfit }]}>Open</Text>
            <Text style={styles.tailLabel}>Still running</Text>
          </>
        ) : nothingToCount ? (
          <>
            <Text style={[styles.value, { color: theme.bentoMuted2 }]}>—</Text>
            <Text style={styles.tailLabel}>Nothing to count</Text>
          </>
        ) : (
          <>
            {/* Sign and word as well as colour: this is the number that decides
                whether someone gets asked about their shift, and colour alone
                fails deutan readers. */}
            <Text style={[styles.value, { color: varianceColor(tone) }]}>
              {variance === 0 ? formatCents(0) : `${variance < 0 ? '−' : '+'}${formatCents(Math.abs(variance))}`}
            </Text>
            <Text style={styles.tailLabel}>
              {tone === 'balanced' ? 'Balanced' : tone === 'short' ? 'Short' : 'Over'}
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

function varianceColor(tone: ReturnType<typeof varianceTone>): string {
  if (tone === 'short') return theme.bentoLoss;
  if (tone === 'over') return theme.bentoProfit;
  return theme.bentoMuted2;
}

function formatMinor(minor: number, code: string, currencies: Currency[]): string {
  if (code === BASE_CURRENCY) return formatCents(minor);
  const currency = currencies.find((c) => c.code === code);
  return currency ? formatForeignCents(minor, currency.symbol) : `${minor / 100} ${code}`;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  meta: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2, fontVariant: ['tabular-nums'] },
  note: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 3, fontStyle: 'italic' },
  tail: { alignItems: 'flex-end', flexShrink: 0 },
  value: { fontSize: 13.5, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tailLabel: { fontSize: 10.5, fontWeight: '700', color: theme.bentoMuted2, marginTop: 1 },
  cardNote: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 12, lineHeight: 17 },
});
