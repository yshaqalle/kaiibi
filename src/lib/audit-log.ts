import { supabase } from '@/lib/supabase';
import { toDateColumn } from '@/lib/period';
import type { AuditAction, AuditEntity, AuditLogEntry } from '@/types/models';

// Reading the accounting audit log. There is no writing half, and there never
// will be: entries are written by database triggers, and the table has no
// insert policy for anyone -- see
// supabase/migrations/20260902000100_accounting_audit_log.sql.

function mapRow(row: any): AuditLogEntry {
  return {
    id: row.id,
    shopId: row.shop_id,
    occurredAt: row.occurred_at,
    actorId: row.actor_id ?? null,
    actorName: row.actor_name ?? null,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id ?? null,
    summary: row.summary,
    amountCents: row.amount_cents ?? null,
    changes: row.changes ?? null,
  };
}

export const AUDIT_ENTITY_LABELS: Record<AuditEntity, string> = {
  expense: 'Expense',
  invoice: 'Bill',
  invoice_payment: 'Bill payment',
  journal_entry: 'Journal entry',
  ledger_account: 'Account',
  cash_account: 'Cash account',
  cash_transfer: 'Transfer',
  fixed_asset: 'Asset',
  budget: 'Budget',
  recurring_bill: 'Recurring bill',
};

// The verb as it reads in a sentence about money, not the database's word for
// it. "Posted" and "Reversed" are what a journal entry actually had done to
// it, and calling both "Created" would flatten the one distinction the log
// exists to preserve.
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  create: 'Added',
  update: 'Edited',
  delete: 'Deleted',
  post: 'Posted',
  reverse: 'Reversed',
  pay: 'Paid',
};

/** Whether an entry took something away — for tone, and for the sign of its amount. */
export function isRemoval(action: AuditAction): boolean {
  return action === 'delete' || action === 'reverse';
}

/**
 * The log, newest first.
 *
 * `since`/`until` filter on when the change was MADE, not on the period the
 * changed row belongs to. That is the right axis for this screen and worth
 * being explicit about: an expense backdated to March and deleted today is
 * today's event, and someone asking "what changed while I was away" would
 * never find it filed under March.
 */
export async function listAuditLog(
  shopId: string,
  {
    since,
    until,
    entity,
    limit = 200,
  }: { since?: Date; until?: Date; entity?: AuditEntity | null; limit?: number } = {}
): Promise<AuditLogEntry[]> {
  let query = supabase
    .from('accounting_audit_log')
    .select('*')
    .eq('shop_id', shopId)
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (since) query = query.gte('occurred_at', since.toISOString());
  // The whole of the closing day, not up to its midnight: `until` arrives as a
  // date the reader picked, and filtering on it directly would silently drop
  // everything that happened after 00:00 on it.
  if (until) query = query.lt('occurred_at', `${toDateColumn(new Date(until.getTime() + 86_400_000))}T00:00:00.000Z`);
  if (entity) query = query.eq('entity', entity);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapRow);
}

/** Everything that ever happened to one row, oldest first — a single thing's history. */
export async function listAuditTrailFor(shopId: string, entity: AuditEntity, entityId: string): Promise<AuditLogEntry[]> {
  const { data, error } = await supabase
    .from('accounting_audit_log')
    .select('*')
    .eq('shop_id', shopId)
    .eq('entity', entity)
    .eq('entity_id', entityId)
    .order('occurred_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapRow);
}

export type AuditChange = { column: string; from: unknown; to: unknown };

/**
 * The `changes` blob as a list a table can render.
 *
 * An edit stores `{column: {from, to}}` and a deletion stores the whole row, so
 * this only unpacks the first shape -- anything without both keys is the
 * second, and printing every column of a deleted row as "changed from
 * undefined" would bury the one line that matters.
 */
export function describeChanges(changes: Record<string, unknown> | null): AuditChange[] {
  if (!changes) return [];
  return Object.entries(changes)
    .filter(([, value]) => value !== null && typeof value === 'object' && 'from' in (value as object) && 'to' in (value as object))
    .map(([column, value]) => ({
      column,
      from: (value as { from: unknown }).from,
      to: (value as { to: unknown }).to,
    }));
}

// Database column names, in the reader's words. Only the ones the audit
// triggers actually track (`audit_tracked_columns` in the migration) -- an
// unlisted column falls through to a de-underscored version of itself, which
// is close enough for a column nobody expected to see.
const COLUMN_LABELS: Record<string, string> = {
  amount_cents: 'Amount',
  cost_cents: 'Cost',
  limit_cents: 'Limit',
  balance_cents: 'Balance',
  salvage_value_cents: 'Salvage value',
  disposal_proceeds_cents: 'Proceeds',
  opening_balance_cents: 'Opening balance',
  opening_balance_on: 'Opening balance date',
  useful_life_months: 'Useful life',
  occurred_on: 'Date',
  issued_on: 'Issued',
  due_on: 'Due',
  acquired_on: 'Acquired',
  disposed_on: 'Disposed',
  next_due_date: 'Next due',
  invoice_number: 'Bill number',
  payment_method: 'Paid with',
  vendor_id: 'Vendor',
  location_id: 'Store',
  account_type: 'Account type',
};

export function auditColumnLabel(column: string): string {
  return COLUMN_LABELS[column] ?? column.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
