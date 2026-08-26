import { supabase } from '@/lib/supabase';
import { fromDateColumn } from '@/lib/period';

// The Supabase-facing half of period close. Read and close; NO ARITHMETIC.
//
// Every figure the Close a Period screen shows is a column
// `list_accounting_periods()` returned -- the profit that was rolled into 3900,
// the date a month closes by itself, what was outstanding when it closed and
// what is outstanding right now. None of it is worked out here, for the reason
// statements.ts states in its own header: two derivations of one figure agree
// until they don't, and then nobody knows which is right.
//
// The one thing this module DOES decide is what to call the person a close is
// attributed to, and that is a rendering decision rather than an arithmetic one
// -- see `closedByLabel`, which is where the whole of it lives so it can be
// tested without a render.

export type PeriodStatus = 'open' | 'closed' | 'locked';

/**
 * One row of `list_accounting_periods()`.
 *
 * `exceptions` is what was RECORDED when the period closed -- the human
 * sentences, frozen, so a pay run posted two months later cannot quietly erase
 * the fact that August was closed over it.
 *
 * `outstanding` is what is outstanding RIGHT NOW, and the function computes it
 * for open periods only: null on a closed or locked one, where the recorded
 * array above is the fact. An open month with nothing outstanding is `[]`, not
 * null -- so null means exactly one thing and the screen never has to guess.
 */
export type AccountingPeriod = {
  id: string;
  /** `date` columns. Never `new Date(startsOn)` -- see period.ts. */
  startsOn: string;
  endsOn: string;
  status: PeriodStatus;
  closedAt: string | null;
  closedBy: string | null;
  exceptions: string[];
  outstanding: string[] | null;
  closingEntryId: string | null;
  /** Minus the closing entry's 3900 line: positive on a profit. 0 when the month did not trade. */
  profitRolledCents: number;
  /** Null unless the shop is on 'automatic' -- there is no date on which 'ask' or 'never' closes. */
  autoCloseDueOn: string | null;
};

/** One row of `period_exceptions()` -- the SAME function the close RPC refuses with. */
export type PeriodException = {
  kind: 'draft_payroll_run' | 'stock_count_missing' | 'register_session_open' | string;
  detail: string;
  count: number;
};

/**
 * Every period of a shop, newest first.
 *
 * THIS CALL WRITES. `list_accounting_periods` closes any period past its grace
 * before it answers -- that is the whole of auto-close, there being no
 * scheduler (20261003000100). A caller who lacks `ledger.close` gets the list
 * and closes nothing; a caller who lacks `ledger.view` gets a raised P0001,
 * which is why this screen has its own refusal state.
 */
export async function listAccountingPeriods(shopId: string): Promise<AccountingPeriod[]> {
  const { data, error } = await supabase.rpc('list_accounting_periods', { p_shop_id: shopId });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
    closedAt: row.closed_at ?? null,
    closedBy: row.closed_by ?? null,
    exceptions: row.exceptions ?? [],
    // `?? null` and NOT `?? []`: the function distinguishes "nothing
    // outstanding" from "not computed, this period is closed", and flattening
    // the two here would throw away the distinction it went to the trouble of
    // making.
    outstanding: row.outstanding ?? null,
    closingEntryId: row.closing_entry_id ?? null,
    // bigint arrives as a STRING over PostgREST, so a bare `+` on it would
    // concatenate rather than add.
    profitRolledCents: Number(row.profit_rolled_cents ?? 0),
    autoCloseDueOn: row.auto_close_due_on ?? null,
  }));
}

/**
 * What is outstanding in a period, from the function `close_accounting_period`
 * itself refuses with.
 *
 * CALLED, NEVER RE-DERIVED. The list a shop is shown before it closes and the
 * list recorded on the period when it does have to be the same list, and the
 * only way to guarantee that is for there to be one of them. Phase 2b's Post
 * History door drifted from its RPC and had to be pinned back by a check;
 * `period_exceptions()` exists so that cannot happen again.
 *
 * Gated on `ledger.view` OR `ledger.close`, so a role holding only the latter
 * can still read its own checklist.
 */
export async function listPeriodExceptions(shopId: string, periodId: string): Promise<PeriodException[]> {
  const { data, error } = await supabase.rpc('period_exceptions', { p_shop_id: shopId, p_period_id: periodId });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    kind: row.kind,
    detail: row.detail,
    count: Number(row.count ?? 0),
  }));
}

/**
 * Closes a period, returning the closing entry -- or null when the month did
 * not trade and there was no honest entry to write.
 *
 * `force = false` REFUSES while anything is outstanding, and the refusal names
 * every item. That refusal is the design's "ask me": the screen shows what the
 * database named and closing again with `force = true` is the reader's second,
 * deliberate act.
 */
export async function closeAccountingPeriod(shopId: string, periodId: string, force = false): Promise<string | null> {
  const { data, error } = await supabase.rpc('close_accounting_period', {
    p_shop_id: shopId,
    p_period_id: periodId,
    p_force: force,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/**
 * Re-opens a closed period by REVERSING its closing entry, never deleting it.
 *
 * The reason is required by the database and is the only explanation the audit
 * trail ever gets: the `accounting_periods` trigger records the status going
 * back to open, and nothing else records why.
 */
export async function reopenAccountingPeriod(shopId: string, periodId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('reopen_accounting_period', {
    p_shop_id: shopId,
    p_period_id: periodId,
    p_reason: reason,
  });
  if (error) throw error;
}

/**
 * A close, as the EXPLICIT audit row records it.
 *
 * A close writes TWO rows to `accounting_audit_log` and that is deliberate
 * (20261003000100): the `accounting_periods` trigger writes a uniform row-diff,
 * and the RPC writes one of its own carrying the entry id, the profit rolled,
 * whether it was forced and what was outstanding -- none of which is on the
 * row, so the trigger cannot see any of it.
 *
 * `after->>'event'` exists so a screen can TELL THEM APART BY FILTER rather
 * than by guessing from the shape of the blob. Only the explicit row has it.
 */
export type PeriodCloseEvent = {
  periodId: string;
  actorId: string | null;
  forced: boolean;
  at: string;
};

/**
 * The most recent close of each period, one row per close.
 *
 * Filtered on `after->>event = 'close'`, which drops the trigger's row-diff
 * twin. Without it every closed month appears twice and the screen has to
 * invent a rule for which of the two it believes.
 *
 * Newest first, and the first sighting of a period wins -- a month closed,
 * re-opened and closed again has several, and the standing one is the last.
 */
export async function listPeriodCloseEvents(shopId: string, limit = 200): Promise<Map<string, PeriodCloseEvent>> {
  const { data, error } = await supabase
    .from('accounting_audit_log')
    .select('actor_id, subject_id, after, created_at')
    .eq('shop_id', shopId)
    .eq('subject_table', 'accounting_periods')
    .eq('after->>event', 'close')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const events = new Map<string, PeriodCloseEvent>();
  for (const row of (data ?? []) as any[]) {
    if (events.has(row.subject_id)) continue;
    events.set(row.subject_id, {
      periodId: row.subject_id,
      actorId: row.actor_id ?? null,
      // The jsonb value is a real boolean, so `=== true` rather than a truthy
      // check on a string that might read 'false'.
      forced: row.after?.forced === true,
      at: row.created_at,
    });
  }
  return events;
}

/** The shop's own close settings, read-only. Changing them is Settings' job, not this screen's. */
export type PeriodCloseSettings = {
  mode: 'automatic' | 'ask' | 'never';
  graceDays: number;
};

export async function getPeriodCloseSettings(shopId: string): Promise<PeriodCloseSettings> {
  const { data, error } = await supabase
    .from('shops')
    .select('auto_close_periods, period_close_grace_days')
    .eq('id', shopId)
    .single();
  if (error) throw error;
  return {
    mode: (data as any).auto_close_periods,
    graceDays: Number((data as any).period_close_grace_days),
  };
}

// ── Rendering decisions, kept pure so they can be tested without a render ────

/** "August 2026", from a period's `starts_on`. */
export function monthLabel(startsOn: string): string {
  return fromDateColumn(startsOn).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** "3 Aug", from a `date` column or a timestamp. */
export function dayLabel(value: string): string {
  const date = value.includes('T') ? new Date(value) : fromDateColumn(value);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * WHO CLOSED A MONTH -- and the one case where naming a person would be a lie.
 *
 * `accounting_periods.closed_by` is `auth.uid()` inside
 * `close_accounting_period`. On a period that closed by ITSELF that uid belongs
 * to whoever's READ triggered the lazy close: auto-close runs on the back of
 * `list_accounting_periods`, so the name on the row is the first person to open
 * an accounting screen after the grace expired. They did not decide anything.
 * Printing their name against the close is the screen asserting a fact nobody
 * established.
 *
 * So the attribution comes from the audit row's `forced` flag rather than from
 * `closed_by`: `close_due_periods()` always forces, so a forced close is one
 * this screen must not put a name to.
 *
 * KNOWN IMPRECISION, stated because it is invisible otherwise: `forced` is ALSO
 * true when a human presses "Close anyway" over outstanding items, so such a
 * close reads "Automatic" too. Nothing in the schema separates the two -- there
 * is no automatic flag, and the actor id is a person's in both cases. Between
 * naming somebody who only read a screen and under-attributing a deliberate
 * force, this errs towards saying less. Recording the distinction is a
 * migration, not a screen change.
 */
export function closedByLabel(event: PeriodCloseEvent | undefined, viewerId: string | null): string {
  // No explicit audit row at all: the period was closed by a direct write under
  // RLS (a `ledger.close` holder may update the row by hand) or before the
  // event key existed. "—" rather than a guess.
  if (!event) return '—';
  if (event.forced) return 'Automatic';
  // A close nobody was signed in for -- a migration or a maintenance script.
  if (!event.actorId) return 'System';
  // Names are not available here: `list_shop_staff` gates on staff.manage and
  // four People permissions, none of which a bookkeeper holding ledger.close
  // need have, so resolving `actor_id` to "Yusef S" as the mockup does would
  // fail for exactly the reader this screen is for. The Audit Log draws the
  // same distinction, in the same words.
  return event.actorId === viewerId ? 'You' : 'A person';
}
