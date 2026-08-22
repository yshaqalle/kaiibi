import { supabase } from '@/lib/supabase';
import type { AccountMovement } from '@/lib/trial-balance';
import { toDateColumn } from '@/lib/period';
import type {
  JournalEntry,
  JournalLine,
  LedgerAccount,
  NewJournalEntryInput,
  NewLedgerAccountInput,
} from '@/types/models';

// Data access for the chart of accounts and the general journal.
//
// Nothing but fetching and writing lives here. The rules -- which way an
// account leans, where it prints, how a trial balance is built -- are in
// chart-of-accounts.ts and trial-balance.ts, which import no Supabase client
// and so can be unit-tested. Same split as expenses.ts / expense-reporting.ts.

function mapAccount(row: any): LedgerAccount {
  return {
    id: row.id,
    shopId: row.shop_id,
    code: row.code,
    name: row.name,
    type: row.type,
    subtype: row.subtype,
    feed: row.feed ?? null,
    contra: row.contra ?? false,
    openingBalanceCents: row.opening_balance_cents ?? 0,
    openingBalanceOn: row.opening_balance_on ?? null,
    isSystem: row.is_system ?? false,
    archived: row.archived ?? false,
    notes: row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLine(row: any): JournalLine {
  return {
    id: row.id,
    entryId: row.entry_id,
    accountId: row.account_id,
    lineNo: row.line_no,
    debitCents: row.debit_cents ?? 0,
    creditCents: row.credit_cents ?? 0,
    memo: row.memo ?? null,
    accountCode: row.account?.code,
    accountName: row.account?.name,
  };
}

function mapEntry(row: any): JournalEntry {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id ?? null,
    entryNo: row.entry_no,
    entryDate: row.entry_date,
    memo: row.memo ?? null,
    reference: row.reference ?? null,
    source: row.source,
    sourceId: row.source_id ?? null,
    reversesId: row.reverses_id ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    // Sorted here rather than relied on from the join: PostgREST does not
    // promise an order on an embedded resource, and an entry whose lines come
    // back shuffled is one the person who wrote it will not recognise.
    lines: (row.lines ?? []).map(mapLine).sort((a: JournalLine, b: JournalLine) => a.lineNo - b.lineNo),
  };
}

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

/**
 * Every account, archived ones included.
 *
 * Archived rows come back on purpose: a statement drawn over a past period
 * still has to name the account a figure sat in, and the callers that want the
 * live chart filter it themselves (`postableAccounts` in chart-of-accounts.ts).
 * Ordering is the client's job too -- see `sortAccounts`, which sorts codes
 * numerically so '1000' comes before '20'.
 */
export async function listLedgerAccounts(shopId: string): Promise<LedgerAccount[]> {
  const { data, error } = await supabase
    .from('ledger_accounts')
    .select('*')
    .eq('shop_id', shopId)
    .order('code', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapAccount);
}

export async function createLedgerAccount(shopId: string, input: NewLedgerAccountInput): Promise<LedgerAccount> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('ledger_accounts')
    .insert({
      shop_id: shopId,
      code: input.code.trim(),
      name: input.name.trim(),
      type: input.type,
      subtype: input.subtype,
      opening_balance_cents: input.openingBalanceCents,
      opening_balance_on: input.openingBalanceOn,
      notes: input.notes,
      created_by: userData.user?.id ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapAccount(data);
}

/**
 * Edits an account. `feed`, `contra` and `is_system` are deliberately not
 * patchable: all three decide how the account is READ, and changing one on a
 * live account silently restates every statement it has ever appeared on.
 */
export async function updateLedgerAccount(
  id: string,
  patch: Partial<NewLedgerAccountInput> & { archived?: boolean }
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('ledger_accounts')
    .update({
      ...(patch.code !== undefined && { code: patch.code.trim() }),
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.type !== undefined && { type: patch.type }),
      ...(patch.subtype !== undefined && { subtype: patch.subtype }),
      ...(patch.openingBalanceCents !== undefined && { opening_balance_cents: patch.openingBalanceCents }),
      ...(patch.openingBalanceOn !== undefined && { opening_balance_on: patch.openingBalanceOn }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
      ...(patch.archived !== undefined && { archived: patch.archived }),
      updated_at: new Date().toISOString(),
      updated_by: userData.user?.id ?? null,
    })
    .eq('id', id);
  if (error) throw error;
}

/**
 * Deletes an account.
 *
 * Refused by the database for a system account, and refused by the foreign key
 * for one with journal lines against it. Both refusals are correct and neither
 * is worth pre-checking here: the client would race the check, and the
 * messages the caller shows are written for exactly these two cases.
 */
export async function deleteLedgerAccount(id: string): Promise<void> {
  const { error } = await supabase.from('ledger_accounts').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

const ENTRY_SELECT = '*, lines:journal_lines(*, account:ledger_accounts(code, name))';

/**
 * The journal, newest first.
 *
 * `entry_no` descending as the tiebreak rather than `created_at`: two entries
 * dated the same day should read in the order they were written, and the
 * number is the only field that is guaranteed to order them.
 */
export async function listJournalEntries(
  shopId: string,
  { since, until, limit = 100 }: { since?: Date; until?: Date; limit?: number } = {}
): Promise<JournalEntry[]> {
  let query = supabase
    .from('journal_entries')
    .select(ENTRY_SELECT)
    .eq('shop_id', shopId)
    .order('entry_date', { ascending: false })
    .order('entry_no', { ascending: false })
    .limit(limit);
  if (since) query = query.gte('entry_date', toDateColumn(since));
  if (until) query = query.lte('entry_date', toDateColumn(until));
  const { data, error } = await query;
  if (error) throw error;

  const entries = (data ?? []).map(mapEntry);
  // Resolved from the same fetch rather than a second query. An entry that has
  // been reversed must SAY so -- otherwise a reader finds the original, acts on
  // it, and never sees the correction sitting three rows above.
  const reversedBy = new Map(entries.filter((e) => e.reversesId).map((e) => [e.reversesId!, e.id]));
  return entries.map((entry) => ({ ...entry, reversedById: reversedBy.get(entry.id) ?? null }));
}

export async function getJournalEntry(id: string): Promise<JournalEntry> {
  const { data, error } = await supabase.from('journal_entries').select(ENTRY_SELECT).eq('id', id).single();
  if (error) throw error;
  return mapEntry(data);
}

/**
 * Posts an entry. Returns the new entry's id.
 *
 * Everything the database will refuse -- an unbalanced entry, a line carrying
 * both a debit and a credit, a line against a fed account -- it refuses with a
 * sentence, and the editor shows that sentence. The client checks balance too,
 * but as a courtesy so the button can be disabled, never as the enforcement.
 */
export async function postJournalEntry(shopId: string, input: NewJournalEntryInput): Promise<string> {
  const { data, error } = await supabase.rpc('post_journal_entry', {
    p_shop_id: shopId,
    p_lines: input.lines.map((line) => ({
      account_id: line.accountId,
      debit_cents: line.debitCents,
      credit_cents: line.creditCents,
      memo: line.memo,
    })),
    p_entry_date: input.entryDate,
    p_memo: input.memo,
    p_reference: input.reference,
    p_location_id: input.locationId,
  });
  if (error) throw error;
  return data as string;
}

/** Posts an entry's mirror image. The original is never touched. */
export async function reverseJournalEntry(entryId: string, reversedOn: string, memo?: string | null): Promise<string> {
  const { data, error } = await supabase.rpc('reverse_journal_entry', {
    p_entry_id: entryId,
    p_reversed_on: reversedOn,
    p_memo: memo ?? null,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Posted debits and credits per account, for the trial balance.
 *
 * An RPC rather than fetching every line and summing here: a shop two years in
 * has tens of thousands of lines, and the trial balance needs one number per
 * account. `to` is inclusive.
 */
export async function ledgerAccountMovement(
  shopId: string,
  { from, to }: { from?: Date | null; to?: Date | null } = {}
): Promise<AccountMovement[]> {
  const { data, error } = await supabase.rpc('ledger_account_movement', {
    p_shop_id: shopId,
    p_from: from ? toDateColumn(from) : null,
    p_to: to ? toDateColumn(to) : null,
  });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    accountId: row.account_id,
    // Postgres sums come back as bigints, which PostgREST serialises as
    // strings once they outgrow a JS-safe integer. Coerced rather than trusted:
    // a string in a subtraction silently becomes NaN and the whole trial
    // balance prints blank.
    debitCents: Number(row.debit_cents ?? 0),
    creditCents: Number(row.credit_cents ?? 0),
  }));
}
