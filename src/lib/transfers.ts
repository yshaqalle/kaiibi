import { supabase } from '@/lib/supabase';

// Moving a shop's own money from one place it keeps money to another.
//
// Both calls gate on budgets.manage in the database -- NOT on a ledger
// permission. That is the whole reason `list_transfer_accounts` exists as a
// function at all: `accounts` is readable on ledger.view alone, which the person
// who banks the float does not hold, so the picker had to come through a door
// gated the same way the write is (20261007000200).
//
// Nothing here decides anything. The four codes, the shop's names for them and
// their balances are the database's; the entry the transfer posts is
// post_journal_entry's. This module names columns and coerces bigints.

export type TransferAccount = {
  code: string;
  /** The SHOP'S name for it — "Bank" for most, "Salaam, Hodan branch" for some. */
  name: string;
  /**
   * Read exactly as cash_flow()'s proof row reads it, so the picker and the
   * statement cannot say different things about the same till.
   */
  balanceCents: number;
};

export async function listTransferAccounts(shopId: string): Promise<TransferAccount[]> {
  const { data, error } = await supabase.rpc('list_transfer_accounts', { p_shop_id: shopId });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    code: row.code,
    name: row.name,
    // bigint arrives as a string over PostgREST.
    balanceCents: Number(row.balance_cents ?? 0),
  }));
}

/**
 * Dr the destination, Cr the source. Returns the journal entry id, which IS the
 * transfer — there is no transfers table and nothing to delete or edit.
 *
 * `on` may be omitted, and then the database uses the SHOP's local date rather
 * than the device's. A date falling in a closed month is recognised in the
 * current one, carrying the true date and the period's status in the
 * description; nothing about that is this module's business.
 */
export async function transferFunds(input: {
  shopId: string;
  fromCode: string;
  toCode: string;
  amountCents: number;
  on: string | null;
  note: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('transfer_funds', {
    p_shop_id: input.shopId,
    p_from_code: input.fromCode,
    p_to_code: input.toCode,
    p_amount_cents: input.amountCents,
    p_on: input.on,
    p_note: input.note,
  });
  if (error) throw error;
  return data as string;
}
