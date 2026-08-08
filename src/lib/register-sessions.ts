// The drawer arithmetic, kept pure so it can be tested and so the close sheet
// can show a preview before the server's own figure comes back.
//
// This mirrors `register_session_expected` / `close_register_session` in
// migration 20260822000000. The server is authoritative — it recomputes
// everything and never trusts a number the client sends, because the client is
// the party the number is checking. What lives here is the same arithmetic run
// locally so the person counting sees the result immediately.
//
// The IO half is `src/lib/registers.ts`; this file imports nothing that touches
// Supabase, which is what lets Jest load it (see the pairing convention:
// sales.ts/sales-reporting.ts, locations.ts/location-selection.ts, and so on).

import type { PaymentLine, RegisterSession, RegisterSessionCash } from '@/types/models';

// The base currency's code as written on `register_session_cash` rows.
// `sale_payments` leaves currency_code null to mean the same thing; the session
// tables spell it out, because a nullable code cannot be made unique per
// session in Postgres.
export const BASE_CURRENCY = 'USD';

// The catch-all key in a denominations map: coins, a torn note, anything that
// is not one of the shop's notes. A plain amount in minor units, not a count.
export const OTHER_DENOMINATION = 'other';

export type VarianceTone = 'balanced' | 'short' | 'over';

/**
 * What a denomination tally adds up to, in minor units.
 *
 * Every key except `other` is a note VALUE multiplied by its count; `other`
 * is already an amount and is added as-is. Unparseable or negative entries
 * count as zero rather than throwing — a half-typed row should read as "not
 * counted yet", not blow up the running total someone is watching.
 *
 * Note values absent from the shop's list are handled identically to seeded
 * ones. That is the point: the list is a starting point, and a cashier holding
 * a 10,000 note the app has never heard of must still be able to count it.
 */
export function tallyTotalMinor(counts: Record<string, number | string | null | undefined>): number {
  let total = 0;
  for (const [key, raw] of Object.entries(counts ?? {})) {
    const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    if (value == null || !Number.isFinite(value) || value <= 0) continue;
    if (key === OTHER_DENOMINATION) {
      total += Math.round(value);
      continue;
    }
    const note = Number.parseInt(key, 10);
    if (!Number.isFinite(note) || note <= 0) continue;
    total += note * Math.round(value);
  }
  return total;
}

/**
 * What the drawer should hold in one currency, given its float and the session's
 * cash movements.
 *
 * Both arguments are already filtered to this currency by `cashMovementsByCurrency`
 * below — the filtering is where the real subtlety lives, not here.
 */
export function expectedMinor(openingFloatMinor: number, netCashInMinor: number): number {
  return Math.round(openingFloatMinor + netCashInMinor);
}

export function varianceMinor(countedMinor: number, expected: number): number {
  return Math.round(countedMinor) - Math.round(expected);
}

export function varianceTone(variance: number): VarianceTone {
  if (variance === 0) return 'balanced';
  return variance < 0 ? 'short' : 'over';
}

/**
 * The net cash a set of payment lines put into the drawer, split by currency.
 *
 * Two traps, both of which produced wrong numbers in earlier drafts:
 *
 *  1. `tenderedCents` is only set when change was given (see
 *     payment-method-picker.tsx), so it is null for exact-tender cash and
 *     cannot be summed. `amountCents` is what was applied and what stayed.
 *
 *  2. On a FOREIGN cash line, `amountCents` is the USD equivalent applied to
 *     the sale — migration 0015 calls the currency columns "display/audit
 *     only" — while the notes that entered the drawer are `foreignAmountCents`.
 *     So the base bucket must EXCLUDE any cash line carrying a currencyCode, or
 *     a shilling sale is counted twice: once as dollars that were never in the
 *     drawer, and again as the shillings that were.
 *
 * Non-cash tenders (ZAAD, e-Dahab) never appear at all. They were never in
 * anyone's hand.
 */
export function cashMovementsByCurrency(payments: readonly PaymentLine[]): Record<string, number> {
  const byCurrency: Record<string, number> = {};
  for (const payment of payments) {
    if (payment.method !== 'cash') continue;
    if (payment.currencyCode) {
      const net = (payment.foreignAmountCents ?? 0) - (payment.foreignChangeCents ?? 0);
      byCurrency[payment.currencyCode] = (byCurrency[payment.currencyCode] ?? 0) + net;
    } else {
      byCurrency[BASE_CURRENCY] = (byCurrency[BASE_CURRENCY] ?? 0) + payment.amountCents;
    }
  }
  return byCurrency;
}

/**
 * The combined variance in base-currency cents.
 *
 * ORDER OF OPERATIONS IS THE WHOLE DESIGN. Each currency is differenced against
 * its own expected figure first — that arithmetic never touches a rate — and
 * only the resulting variances are converted and summed here.
 *
 * Convert the balances and difference those instead, and a rate drifting from
 * 115 to 118 reports about $80 of variance on a 355,000 Sl Sh drawer where
 * every note stayed exactly where it was: a fabricated accusation against
 * whoever was on the register. Converting a −$5 variance at 115 or at 118
 * changes it by pennies, which is why doing it in this order is safe.
 */
export function combinedVarianceBaseCents(rows: readonly RegisterSessionCash[]): number {
  let total = 0;
  for (const row of rows) {
    const variance = row.varianceMinor ?? 0;
    if (variance === 0) continue;
    const rate = row.closingRateToUsd ?? row.openingRateToUsd;
    if (!rate || rate <= 0) continue;
    total += variance / rate;
  }
  return Math.round(total);
}

/**
 * What the held balance in one currency is worth now versus at open, in
 * base-currency cents.
 *
 * This is the day's exchange exposure on the float, and it is REAL money — but
 * it is not a cash discrepancy, so it is reported on its own and never folded
 * into the variance. Mixing them tells a cashier they are $83 short when they
 * are $5 short.
 *
 * Positive means the holding gained value.
 */
export function fxDriftBaseCents(row: RegisterSessionCash): number {
  const held = row.closingCountedMinor;
  const closingRate = row.closingRateToUsd;
  if (held == null || !closingRate || closingRate <= 0) return 0;
  if (!row.openingRateToUsd || row.openingRateToUsd <= 0) return 0;
  // Base currency never drifts against itself, and a rate of 1 at both ends
  // would return 0 anyway — but skipping it keeps floating-point noise out.
  if (row.currencyCode === BASE_CURRENCY) return 0;
  return Math.round(held / closingRate - held / row.openingRateToUsd);
}

export function totalFxDriftBaseCents(rows: readonly RegisterSessionCash[]): number {
  return rows.reduce((sum, row) => sum + fxDriftBaseCents(row), 0);
}

/**
 * Whether this person may close this session.
 *
 * Your own, or you hold `registers.manage`. Signing off someone else's variance
 * is a supervisory act — this mirrors the check inside
 * `close_register_session`, which is the one that actually decides.
 */
export function canCloseSession(
  session: Pick<RegisterSession, 'shopMemberId' | 'closedAt'>,
  myMemberId: string | null,
  canManageRegisters: boolean
): boolean {
  if (session.closedAt) return false;
  if (myMemberId && session.shopMemberId === myMemberId) return true;
  return canManageRegisters;
}

/**
 * Which currencies the close sheet should ask about.
 *
 * Only what this session actually saw: a currency it was given a float in, or
 * one it took cash in. A ZAAD-only mobile session therefore has nothing to
 * count and closes in one tap — demanding a $0.00 confirmation anyway just
 * trains people to type zero without reading.
 *
 * Base currency sorts first, then the rest alphabetically, so the block order
 * on screen is stable between the open sheet and the close sheet.
 */
export function currenciesToCount(
  cash: readonly RegisterSessionCash[],
  cashMovements: Record<string, number>
): string[] {
  const codes = new Set<string>();
  for (const row of cash) {
    if (row.openingFloatMinor > 0 || row.closingCountedMinor != null) codes.add(row.currencyCode);
  }
  for (const [code, amount] of Object.entries(cashMovements)) {
    if (amount !== 0) codes.add(code);
  }
  return [...codes].sort((a, b) => {
    if (a === BASE_CURRENCY) return -1;
    if (b === BASE_CURRENCY) return 1;
    return a.localeCompare(b);
  });
}

/**
 * How long a session has been open, for the register bar.
 *
 * Under a day it reads as a duration ("3h 12m"); past midnight it switches to
 * the weekday it started ("since Thu 08:12"). A session may stay open as long
 * as the shop wants — that is explicitly allowed — so "27h" is information the
 * bar has no business shouting about, while the day it started is the thing
 * someone actually needs to know.
 */
export function formatSessionWindow(openedAt: string, now: Date = new Date()): string {
  const opened = new Date(openedAt);
  if (Number.isNaN(opened.getTime())) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - opened.getTime()) / 60_000));
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    if (hours === 0) return `open ${minutes}m`;
    return `open ${hours}h ${minutes % 60}m`;
  }
  const weekday = opened.toLocaleDateString(undefined, { weekday: 'short' });
  const time = opened.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `since ${weekday} ${time}`;
}

/**
 * Every session in one continuous RUN of a register, oldest first.
 *
 * A handover closes one session and opens another, so a till worked by two
 * people is two rows and one thing in someone's head. The chain is walked
 * through `handedOverFrom` and never through timestamps: a close followed by a
 * fresh open a minute later looks identical by time and is emphatically NOT a
 * handover — that close drew a money boundary on purpose.
 *
 * Pure, and separated from the query that feeds it, because the walk has the
 * failure modes worth testing: a missing predecessor, a link to a session on
 * another register, and a cycle that no RPC can create but a hand-edited row
 * can — and any of the three hanging the sheet would be worse than the feature.
 */
export function assembleRun(
  anchorId: string,
  sessions: readonly RegisterSession[]
): RegisterSession[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const anchor = byId.get(anchorId);
  if (!anchor) return [];

  const byPredecessor = new Map<string, RegisterSession>();
  for (const session of sessions) {
    // Only within this register: a link pointing elsewhere is data damage, and
    // following it would splice another till's takings into this run.
    if (session.handedOverFrom && byId.has(session.handedOverFrom)) {
      byPredecessor.set(session.handedOverFrom, session);
    }
  }

  const seen = new Set<string>([anchor.id]);
  let first = anchor;
  while (first.handedOverFrom) {
    const previous = byId.get(first.handedOverFrom);
    if (!previous || seen.has(previous.id)) break;
    seen.add(previous.id);
    first = previous;
  }

  const run: RegisterSession[] = [first];
  let cursor = first;
  for (;;) {
    const next = byPredecessor.get(cursor.id);
    if (!next || run.some((session) => session.id === next.id)) break;
    run.push(next);
    cursor = next;
  }
  return run;
}

/**
 * A finished session's window: when it ran, and for how long.
 *
 * Distinct from `formatSessionWindow`, which is for the LIVE bar and always
 * reads "open 3h 12m". Reusing it on a closed session claimed a register was
 * still running seven hours after it was counted and signed off.
 */
export function formatSessionRange(openedAt: string, closedAt: string | null, now: Date = new Date()): string {
  if (!closedAt) return formatSessionWindow(openedAt, now);
  const opened = new Date(openedAt);
  const closed = new Date(closedAt);
  if (Number.isNaN(opened.getTime()) || Number.isNaN(closed.getTime())) return '';
  const time = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const minutes = Math.max(0, Math.round((closed.getTime() - opened.getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  const length = hours === 0 ? `${minutes}m` : `${hours}h ${minutes % 60}m`;
  // The day only when it is not the day it closed — a session that opened at
  // 08:12 and closed at 15:00 the same day needs no dates cluttering it.
  const sameDay = opened.toDateString() === closed.toDateString();
  const day = sameDay ? '' : `${opened.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} `;
  return `${day}${time(opened)} → ${time(closed)} · ${length}`;
}

/**
 * What each tender took on a session, largest first.
 *
 * All tenders, not just cash: this answers "how did this register do", which is
 * a different question from "does the drawer add up" and must not be confused
 * with it. Foreign cash is reported in base-currency terms here because the
 * question is about takings, not about which notes are in the drawer.
 */
export function paymentBreakdown(
  payments: readonly PaymentLine[]
): { method: PaymentLine['method']; count: number; totalCents: number }[] {
  const byMethod = new Map<PaymentLine['method'], { count: number; totalCents: number }>();
  for (const payment of payments) {
    const current = byMethod.get(payment.method) ?? { count: 0, totalCents: 0 };
    current.count += 1;
    current.totalCents += payment.amountCents;
    byMethod.set(payment.method, current);
  }
  return [...byMethod.entries()]
    .map(([method, totals]) => ({ method, ...totals }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

/**
 * The shop's note list with one value added, largest first.
 *
 * Used when a cashier meets a note the seeded list does not know about — a
 * 10,000 shilling, a 200 dollar — and chooses to keep it. Deduped, because
 * adding a note that already exists should be a no-op rather than a second row
 * that splits the count for one denomination across two lines.
 *
 * Returns the map unchanged when there is nothing to do, so a caller can skip
 * the write by identity.
 */
export function withDenomination(
  denominations: Record<string, number[]> | null | undefined,
  currencyCode: string,
  minor: number
): Record<string, number[]> {
  const current = denominations ?? {};
  if (!Number.isFinite(minor) || minor <= 0) return current;
  const existing = current[currencyCode] ?? [];
  if (existing.includes(minor)) return current;
  return { ...current, [currencyCode]: [...existing, minor].sort((a, b) => b - a) };
}

/** The same list with one value removed. A currency left with no notes keeps an
 * empty array rather than disappearing, so the editor can still show it. */
export function withoutDenomination(
  denominations: Record<string, number[]> | null | undefined,
  currencyCode: string,
  minor: number
): Record<string, number[]> {
  const current = denominations ?? {};
  const existing = current[currencyCode];
  if (!existing || !existing.includes(minor)) return current;
  return { ...current, [currencyCode]: existing.filter((note) => note !== minor) };
}

/**
 * The note values the tally offers for a currency, largest first.
 *
 * Counting a drawer starts with the biggest notes, so the rows should too.
 * An unknown currency gets an empty list rather than the dollar notes — a
 * wrong list is worse than no list, because it invites someone to count 5,000
 * shillings into a row labelled $5.
 */
export function denominationsFor(
  denominations: Record<string, number[]> | null | undefined,
  currencyCode: string
): number[] {
  const list = denominations?.[currencyCode] ?? [];
  return [...list].filter((note) => Number.isFinite(note) && note > 0).sort((a, b) => b - a);
}
