import { supabase } from '@/lib/supabase';
import type { Account, JournalEntry, JournalLine } from '@/types/models';
import type { PostedLine } from '@/lib/ledger-math';
import { summariseUnposted, type UnpostedSummary } from '@/lib/ledger-backfill';

// The Supabase-facing half of the ledger. Every number this returns is computed
// by the database; nothing here decides anything. The arithmetic lives in
// ledger-math.ts so it can be tested without a runtime.

function mapAccount(row: any): Account {
  return {
    id: row.id,
    shopId: row.shop_id,
    code: row.code,
    name: row.name,
    type: row.type,
    isContra: row.is_contra,
    archivedAt: row.archived_at ?? null,
  };
}

function mapLine(row: any): JournalLine {
  return {
    id: row.id,
    accountId: row.account_id,
    amountCents: row.amount_cents,
    locationId: row.location_id ?? null,
    memo: row.memo ?? null,
  };
}

// Archived accounts are included. A statement covering a period in which an
// account was still live must still be able to name it, and the caller filters
// for pickers -- which is a different question from "what happened".
export async function listAccounts(shopId: string): Promise<Account[]> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, shop_id, code, name, type, is_contra, archived_at')
    .eq('shop_id', shopId)
    .order('code');
  if (error) throw error;
  return (data ?? []).map(mapAccount);
}

export async function listJournalEntries(shopId: string, from: string, to: string): Promise<JournalEntry[]> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select(
      'id, shop_id, entry_date, reference, description, source, status, location_id, reverses_entry_id, created_at,' +
        'journal_lines (id, account_id, amount_cents, location_id, memo)'
    )
    .eq('shop_id', shopId)
    .gte('entry_date', from)
    .lte('entry_date', to)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    id: row.id,
    shopId: row.shop_id,
    entryDate: row.entry_date,
    reference: row.reference ?? null,
    description: row.description,
    source: row.source,
    status: row.status,
    locationId: row.location_id ?? null,
    reversesEntryId: row.reverses_entry_id ?? null,
    createdAt: row.created_at,
    lines: (row.journal_lines ?? []).map(mapLine),
  }));
}

// Every posted line up to a date, for the trial balance. Reversals are included
// deliberately: a reversed entry and its mirror both stay on the books and net
// to nothing, so excluding either would unbalance the statement. Drafts are
// excluded because they have not reached the books.
export async function listPostedLines(shopId: string, asOf: string): Promise<PostedLine[]> {
  const { data, error } = await supabase
    .from('journal_lines')
    .select('account_id, amount_cents, journal_entries!inner (shop_id, entry_date, status)')
    .eq('journal_entries.shop_id', shopId)
    .lte('journal_entries.entry_date', asOf)
    .in('journal_entries.status', ['posted', 'reversed']);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    accountId: row.account_id,
    amountCents: row.amount_cents,
  }));
}

export type PostEntryInput = {
  shopId: string;
  entryDate: string;
  description: string;
  // amountCents is signed: debit positive, credit negative.
  lines: { code: string; amountCents: number; memo?: string | null; locationId?: string | null }[];
  locationId?: string | null;
};

export async function postJournalEntry(input: PostEntryInput): Promise<string> {
  const { data, error } = await supabase.rpc('post_journal_entry', {
    p_shop_id: input.shopId,
    p_entry_date: input.entryDate,
    p_description: input.description,
    p_lines: input.lines.map((line) => ({
      code: line.code,
      amount_cents: line.amountCents,
      memo: line.memo ?? null,
      location_id: line.locationId ?? null,
    })),
    p_location_id: input.locationId ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function reverseJournalEntry(entryId: string, reason: string): Promise<string> {
  const { data, error } = await supabase.rpc('reverse_journal_entry', {
    p_entry_id: entryId,
    p_reason: reason,
  });
  if (error) throw error;
  return data as string;
}

// ── The Post History door ──────────────────────────────────────────────────
//
// Both calls gate on ledger.close in the database. The hub hides the card
// without it, which stops an honest reader reaching a button that raises and
// stops nothing else -- these functions are reachable over PostgREST by anyone,
// and the gate that matters is the one inside them.

/**
 * How many rows of each kind are waiting to reach the ledger, and how far back
 * the oldest goes. Reads only; writes nothing and takes no lock.
 *
 * The counting is entirely the database's. `unposted_ledger_counts` reads the
 * `unposted_ledger_sources` view, which carries the same eight per-kind
 * predicates the replay does -- so the door cannot promise entries the replay
 * will not write. Doing it here instead would be a second definition of
 * "unposted", and it would be wrong in ways that look right (a sale's own
 * tenders keep a null `journal_entry_id` for ever).
 */
export async function listUnpostedLedgerCounts(shopId: string): Promise<UnpostedSummary> {
  // TWO CALLS, IN PARALLEL, AND BOTH MUST SUCCEED. The exposure is not a nicety
  // bolted on after the counts: showing "412 entries" without "and 3 of your
  // shut months receive them" is the screen that was there before, and it told
  // the reader the opposite of the truth. If the second call fails the card
  // shows its failure caveat rather than a number with a silent omission behind
  // it. Both gate on ledger.close, so they fail together or not at all.
  const [counts, exposure] = await Promise.all([
    supabase.rpc('unposted_ledger_counts', { p_shop_id: shopId }),
    supabase.rpc('unposted_ledger_period_exposure', { p_shop_id: shopId }),
  ]);
  if (counts.error) throw counts.error;
  if (exposure.error) throw exposure.error;
  return summariseUnposted(
    (counts.data ?? []).map((row: any) => ({
      kind: row.kind,
      // bigint arrives as a string over PostgREST, so a bare `+` on it would
      // concatenate rather than add.
      rowsUnposted: Number(row.rows_unposted ?? 0),
      oldestOn: row.oldest_on ?? null,
    })),
    (exposure.data ?? []).map((row: any) => ({
      status: row.status,
      months: Number(row.months ?? 0),
      entries: Number(row.entries ?? 0),
    }))
  );
}

/**
 * Replays every unposted sale, refund, settlement, delivery, stock count,
 * supplier payment, pay run and expense into the ledger, and returns how many
 * entries it wrote.
 *
 * Idempotent: a second call writes nothing and returns 0. It takes a per-shop
 * advisory lock, so two people pressing at once cannot each write a complete
 * set of entries and orphan one of them.
 */
export async function backfillShopLedger(shopId: string): Promise<number> {
  const { data, error } = await supabase.rpc('backfill_shop_ledger', { p_shop_id: shopId });
  if (error) throw error;
  return Number(data ?? 0);
}

export type AuditRow = {
  id: string;
  actorId: string | null;
  action: 'insert' | 'update' | 'delete';
  subjectTable: string;
  subjectId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
};

// Newest first, capped. The log is append-only and grows without bound, so a
// screen that fetched all of it would get slower every day it worked.
export async function listAuditLog(shopId: string, limit = 200): Promise<AuditRow[]> {
  const { data, error } = await supabase
    .from('accounting_audit_log')
    .select('id, actor_id, action, subject_table, subject_id, before, after, created_at')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    actorId: row.actor_id ?? null,
    action: row.action,
    subjectTable: row.subject_table,
    subjectId: row.subject_id,
    before: row.before ?? null,
    after: row.after ?? null,
    createdAt: row.created_at,
  }));
}
