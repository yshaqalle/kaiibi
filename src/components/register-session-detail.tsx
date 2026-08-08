import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppModal } from '@/components/ui/app-modal';
import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents, formatForeignCents } from '@/lib/currency';
import { methodLabel } from '@/lib/payment-methods';
import { sessionRun, sessionTransactions } from '@/lib/registers';
import {
  BASE_CURRENCY,
  formatSessionRange,
  paymentBreakdown,
  varianceTone,
} from '@/lib/register-sessions';
import type { Currency, RegisterSession, SessionTransaction } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// One register's RUN, not one person's turn.
//
// A handover closes one session and opens another, so a till worked by two
// people is two rows in the database and one thing in someone's head. This
// sheet follows the chain: combined totals on top, then each person with their
// OWN variance, then every transaction in the order it happened with the
// handover marked where it falls.
//
// The split matters. Takings combine across a handover because the register
// took them; a variance never does, because a drawer count belongs to whoever
// signed it and merging two people's would make neither answerable for it.

const SERIES = [theme.bentoSeries1, theme.bentoSeries2, theme.bentoSeries3, theme.bentoSeries4];

export function RegisterSessionDetail({
  sessionId,
  registerName,
  nameFor,
  currencies,
  onClose,
}: {
  sessionId: string;
  registerName: string;
  /** Resolves a session to whoever was on it — the caller already holds the roster. */
  nameFor: (session: RegisterSession) => string;
  currencies: Currency[];
  onClose: () => void;
}) {
  const [run, setRun] = useState<RegisterSession[]>([]);
  const [transactions, setTransactions] = useState<SessionTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    sessionRun(sessionId)
      .then(async (sessions) => {
        if (cancelled) return;
        setRun(sessions);
        const rows = await sessionTransactions(sessions.map((session) => session.id));
        if (!cancelled) setTransactions(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(extractErrorMessage(err, 'Could not load this register session.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const open = run.some((session) => !session.closedAt);
  const first = run[0];
  const allPayments = transactions.flatMap((row) => row.payments);
  const takenCents = transactions.reduce((sum, row) => sum + row.totalCents, 0);
  const refundedCents = transactions
    .filter((row) => row.kind === 'refund')
    .reduce((sum, row) => sum + row.totalCents, 0);
  const saleCount = transactions.filter((row) => row.kind === 'sale').length;
  const mix = paymentBreakdown(allPayments);
  const mixMax = mix.reduce((max, row) => Math.max(max, row.totalCents), 0);

  // What is in the drawer now, per currency: the latest session's float plus
  // what it has taken, or its counted figure once closed.
  const last = run[run.length - 1];
  const drawer = (last?.cash ?? []).map((cash) => ({
    code: cash.currencyCode,
    minor: cash.closingCountedMinor ?? cash.expectedMinor ?? cash.openingFloatMinor,
  }));

  return (
    <AppModal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <View style={styles.headTitles}>
              <Text style={styles.title}>{registerName}</Text>
              <Text style={styles.sub}>
                {run.length > 1 ? `${run.length} people · ` : ''}
                {first ? formatSessionRange(first.openedAt, open ? null : last?.closedAt ?? null) : ''}
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.headBtn}>
              <Text style={styles.headBtnText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            {loading && <Text style={styles.muted}>Loading…</Text>}
            {error && <Text style={styles.error}>{error}</Text>}

            {!loading && !error && (
              <>
                <View style={styles.tiles}>
                  <Tile
                    label="Taken"
                    value={formatCents(takenCents)}
                    hint={`${saleCount === 1 ? '1 sale' : `${saleCount} sales`} · all tenders`}
                  />
                  {drawer.map((entry) => (
                    <Tile
                      key={entry.code}
                      label={entry.code === BASE_CURRENCY ? 'In the drawer' : entry.code}
                      value={formatMinor(entry.minor, entry.code, currencies)}
                      hint={open ? 'right now' : 'counted at close'}
                    />
                  ))}
                  {refundedCents !== 0 && (
                    <Tile label="Refunded" value={formatCents(refundedCents)} hint="out of this drawer" />
                  )}
                </View>
                {run.length > 1 && (
                  <Text style={styles.note}>
                    Everything above spans the handover. Each person&rsquo;s own figures — and their own variance — are
                    below, because a drawer count belongs to whoever signed it.
                  </Text>
                )}

                <View style={styles.block}>
                  <Text style={styles.label}>{run.length > 1 ? 'Who has been on it' : 'Who is on it'}</Text>
                  {run.map((session, index) => (
                    <View key={session.id}>
                      {index > 0 && session.handedOverFrom ? (
                        <Text style={styles.handoverNote}>
                          Handed over at{' '}
                          {new Date(session.openedAt).toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                          })}
                          {' · '}
                          {session.cash
                            .filter((cash) => cash.openingFloatMinor > 0)
                            .map((cash) => formatMinor(cash.openingFloatMinor, cash.currencyCode, currencies))
                            .join(' + ') || 'nothing'}{' '}
                          carried across as the next float
                        </Text>
                      ) : null}
                      <PersonRow session={session} name={nameFor(session)} currencies={currencies} />
                    </View>
                  ))}
                </View>

                {mix.length > 0 && (
                  <View style={styles.block}>
                    <Text style={styles.label}>How it was paid</Text>
                    {mix.map((row, index) => (
                      <View key={row.method} style={styles.mixRow}>
                        <Text style={styles.mixName}>{methodLabel(row.method)}</Text>
                        <View style={styles.mixTrack}>
                          <View
                            style={[
                              styles.mixBar,
                              {
                                width: `${mixMax > 0 ? Math.max(4, (row.totalCents / mixMax) * 100) : 0}%`,
                                backgroundColor: SERIES[index % SERIES.length],
                              },
                            ]}
                          />
                        </View>
                        <Text style={styles.mixCount}>{row.count}</Text>
                        <Text style={styles.mixAmt}>{formatCents(row.totalCents)}</Text>
                      </View>
                    ))}
                    <Text style={styles.note}>
                      Foreign cash counts at what it was worth to the sale — this answers how the register did. The
                      drawer figures above count the notes themselves, and the two are never added together.
                    </Text>
                  </View>
                )}

                <View style={styles.block}>
                  <Text style={styles.label}>Transactions</Text>
                  {transactions.length === 0 ? (
                    <Text style={styles.muted}>Nothing has been rung through this register yet.</Text>
                  ) : (
                    transactions.map((row) => <TransactionRow key={`${row.kind}-${row.id}`} row={row} />)
                  )}
                </View>

                {run.some((session) => session.openingNote || session.closingNote) && (
                  <View style={styles.block}>
                    <Text style={styles.label}>Notes</Text>
                    {run.map((session) =>
                      [session.openingNote, session.closingNote].filter(Boolean).map((note, index) => (
                        <Text key={`${session.id}-${index}`} style={styles.noteLine}>
                          &ldquo;{note}&rdquo; — {nameFor(session)}
                        </Text>
                      ))
                    )}
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

function PersonRow({
  session,
  name,
  currencies,
}: {
  session: RegisterSession;
  name: string;
  currencies: Currency[];
}) {
  const open = !session.closedAt;
  const variance = session.varianceBaseCents ?? 0;
  const tone = varianceTone(variance);
  const floats = session.cash
    .filter((cash) => cash.openingFloatMinor > 0)
    .map((cash) => formatMinor(cash.openingFloatMinor, cash.currencyCode, currencies));

  return (
    <View style={styles.person}>
      <View style={styles.personBody}>
        <Text style={styles.personName}>{name}</Text>
        <Text style={styles.personWhen}>
          {formatSessionRange(session.openedAt, session.closedAt)}
          {floats.length > 0 ? ` · float ${floats.join(' + ')}` : ''}
        </Text>
      </View>
      <View style={styles.personTail}>
        {open ? (
          <Text style={[styles.personVariance, { color: theme.bentoProfit }]}>Still running</Text>
        ) : session.cash.length === 0 ? (
          <Text style={[styles.personVariance, { color: theme.bentoMuted2 }]}>Nothing to count</Text>
        ) : (
          <Text
            style={[
              styles.personVariance,
              { color: tone === 'short' ? theme.bentoLoss : tone === 'over' ? theme.bentoProfit : theme.bentoMuted2 },
            ]}
          >
            {variance === 0
              ? 'Balanced'
              : `${variance < 0 ? '−' : '+'}${formatCents(Math.abs(variance))} ${tone}`}
          </Text>
        )}
      </View>
    </View>
  );
}

function TransactionRow({ row }: { row: SessionTransaction }) {
  const time = new Date(row.createdAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const detail =
    row.kind === 'refund'
      ? 'Refund · cash out of this drawer'
      : row.payments.map(describePayment).join(' + ') || '—';

  return (
    <View style={styles.txRow}>
      <Text style={styles.txTime}>{time}</Text>
      <View style={styles.txBody}>
        <Text style={styles.txName}>
          {row.kind === 'refund'
            ? 'Refund'
            : `${row.itemCount} ${row.itemCount === 1 ? 'item' : 'items'}`}
          {row.customerName ? ` · ${row.customerName}` : ''}
        </Text>
        <Text style={styles.txMeta}>{detail}</Text>
      </View>
      <Text style={[styles.txAmt, row.totalCents < 0 && { color: theme.bentoLoss }]}>
        {row.totalCents < 0 ? '−' : ''}
        {formatCents(Math.abs(row.totalCents))}
      </Text>
    </View>
  );
}

// The tender detail worth seeing on a row: what was handed over and what came
// back, which is the difference between "took $20" and "took $17.20".
function describePayment(payment: SessionTransaction['payments'][number]): string {
  const label = methodLabel(payment.method);
  if (payment.currencyCode && payment.foreignAmountCents != null) {
    const change = payment.foreignChangeCents
      ? `, ${payment.foreignChangeCents / 100} change`
      : '';
    return `${label} · ${payment.currencyCode} ${payment.foreignAmountCents / 100} in${change}`;
  }
  if (payment.tenderedCents != null) {
    return `${label} · ${formatCents(payment.tenderedCents)} tendered, ${formatCents(
      payment.tenderedCents - payment.amountCents
    )} change`;
  }
  return `${label} ${formatCents(payment.amountCents)}`;
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileHint}>{hint}</Text>
    </View>
  );
}

function formatMinor(minor: number, code: string, currencies: Currency[]): string {
  if (code === BASE_CURRENCY) return formatCents(minor);
  const currency = currencies.find((c) => c.code === code);
  return currency ? formatForeignCents(minor, currency.symbol) : `${minor / 100} ${code}`;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.bentoPage, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '92%' },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingTop: 16 },
  headTitles: { flex: 1, minWidth: 0 },
  title: { fontSize: 18, fontWeight: '800', letterSpacing: -0.5, color: theme.bentoInk },
  sub: { fontSize: 12, color: theme.bentoMuted, marginTop: 2 },
  headBtn: { borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  headBtnText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoInk2 },
  body: { padding: 16, gap: 8 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { flexGrow: 1, minWidth: 140, backgroundColor: theme.surface, borderRadius: BENTO_RADIUS_TILE, padding: 13 },
  tileLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.bentoMuted,
  },
  tileValue: { fontSize: 20, fontWeight: '800', letterSpacing: -0.6, color: theme.bentoInk, marginTop: 3 },
  tileHint: { fontSize: 11, color: theme.bentoMuted2, marginTop: 1 },
  block: { backgroundColor: theme.surface, borderRadius: BENTO_RADIUS_TILE, padding: 15 },
  label: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    color: theme.bentoMuted,
    marginBottom: 9,
  },
  note: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 9, lineHeight: 17 },
  noteLine: { fontSize: 12, color: theme.bentoInk2, marginBottom: 5, lineHeight: 17 },
  muted: { fontSize: 12.5, color: theme.bentoMuted },
  error: { fontSize: 12.5, color: theme.bentoLoss, fontWeight: '600' },
  person: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10 },
  personBody: { flex: 1, minWidth: 0 },
  personName: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  personWhen: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 1 },
  personTail: { flexShrink: 0 },
  personVariance: { fontSize: 12, fontWeight: '800' },
  handoverNote: {
    fontSize: 11,
    color: theme.bentoMuted,
    lineHeight: 16,
    marginLeft: 6,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: theme.bentoRule,
    paddingVertical: 4,
  },
  mixRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  mixName: { fontSize: 12.5, fontWeight: '700', width: 84, color: theme.bentoInk },
  mixTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: theme.bentoSoft, overflow: 'hidden' },
  mixBar: { height: '100%', borderRadius: 4 },
  mixCount: { fontSize: 11, color: theme.bentoMuted2, width: 24, textAlign: 'right' },
  mixAmt: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, minWidth: 74, textAlign: 'right' },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoRule,
  },
  txTime: { fontSize: 11.5, color: theme.bentoMuted, width: 46 },
  txBody: { flex: 1, minWidth: 0 },
  txName: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },
  txMeta: { fontSize: 11, color: theme.bentoMuted2, marginTop: 1 },
  txAmt: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk },
});
