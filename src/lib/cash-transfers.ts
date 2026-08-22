import { supabase } from '@/lib/supabase';
import { toDateColumn } from '@/lib/period';
import type { CashTransfer } from '@/types/models';

// Moving money between the shop's own pots.
//
// One thing worth knowing before reading anything here: a transfer changes no
// total the app reports. It does not touch profit, and it does not change how
// much cash the business holds -- only which drawer it is in. See
// supabase/migrations/20260902000400_cash_transfers.sql.

function mapRow(row: any): CashTransfer {
  return {
    id: row.id,
    shopId: row.shop_id,
    fromAccountId: row.from_account_id,
    toAccountId: row.to_account_id,
    fromAccountName: row.from_account?.name ?? null,
    toAccountName: row.to_account?.name ?? null,
    amountCents: row.amount_cents,
    transferredOn: row.transferred_on,
    reference: row.reference ?? null,
    note: row.note ?? null,
    createdAt: row.created_at,
  };
}

// Two aliased embeds of the same table. The alias is required, not stylistic:
// PostgREST cannot tell which foreign key an unaliased `cash_accounts(name)`
// means when there are two, and answers with an error rather than a guess.
const SELECT_WITH_ACCOUNTS =
  '*, from_account:cash_accounts!cash_transfers_from_account_id_fkey(name), to_account:cash_accounts!cash_transfers_to_account_id_fkey(name)';

export async function listCashTransfers(
  shopId: string,
  { since, until, limit = 100 }: { since?: Date; until?: Date; limit?: number } = {}
): Promise<CashTransfer[]> {
  let query = supabase
    .from('cash_transfers')
    .select(SELECT_WITH_ACCOUNTS)
    .eq('shop_id', shopId)
    .order('transferred_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (since) query = query.gte('transferred_on', toDateColumn(since));
  if (until) query = query.lte('transferred_on', toDateColumn(until));
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapRow);
}

/**
 * Records a transfer and moves both balances, in one transaction.
 *
 * Through the RPC because the two balance changes have to land together: two
 * client-side updates can half-succeed, and what that leaves behind is a shop
 * that looks poorer or richer by the transferred amount with nothing on any
 * screen to explain it.
 */
export async function recordCashTransfer(input: {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  transferredOn: string;
  reference: string | null;
  note: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('record_cash_transfer', {
    p_from_account_id: input.fromAccountId,
    p_to_account_id: input.toAccountId,
    p_amount_cents: input.amountCents,
    p_transferred_on: input.transferredOn,
    p_reference: input.reference,
    p_note: input.note,
  });
  if (error) throw error;
  return data as string;
}
