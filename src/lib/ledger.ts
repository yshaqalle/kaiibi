import { supabase } from '@/lib/supabase';
import type { Account, JournalEntry, JournalLine } from '@/types/models';
import type { PostedLine } from '@/lib/ledger-math';

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
