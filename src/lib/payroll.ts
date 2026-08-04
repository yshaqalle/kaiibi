import type { PayrollDraftLine } from '@/lib/payroll-reporting';
import { supabase } from '@/lib/supabase';
import type { PayrollRun, PayrollRunLine } from '@/types/models';

// Data access for pay runs. The arithmetic lives in payroll-reporting.ts so it
// stays testable.

function mapLineRow(row: any): PayrollRunLine {
  return {
    id: row.id,
    payrollRunId: row.payroll_run_id,
    shopMemberId: row.shop_member_id,
    memberName: row.member_name,
    payType: row.pay_type,
    payRateCents: row.pay_rate_cents,
    hoursWorked: row.hours_worked !== null && row.hours_worked !== undefined ? Number(row.hours_worked) : null,
    amountCents: row.amount_cents,
    note: row.note,
    warning: row.warning ?? null,
    warningBlocking: row.warning_blocking ?? false,
    createdAt: row.created_at,
  };
}

function mapRunRow(row: any): PayrollRun {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id ?? null,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    cadence: row.cadence,
    totalCents: row.total_cents ?? 0,
    expenseId: row.expense_id,
    postedAt: row.posted_at,
    postedBy: row.posted_by,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: (row.payroll_run_lines ?? []).map(mapLineRow),
  };
}

const SELECT_WITH_LINES = '*, payroll_run_lines(*)';

export async function listPayrollRuns(shopId: string): Promise<PayrollRun[]> {
  const { data, error } = await supabase
    .from('payroll_runs')
    .select(SELECT_WITH_LINES)
    .eq('shop_id', shopId)
    .order('period_end', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapRunRow);
}

// Creates the run and its computed lines together. The lines are written from
// an already-computed draft rather than recomputed server-side, so what gets
// stored is exactly what was reviewed on screen.
// `locationId` is which store's labour this run covers. Null = the whole
// business, which is the right answer for a shop that runs one payroll across
// every store, and stays the default so nothing changes for a single-store
// shop. When set, posting the run produces an expense carrying the same store,
// so labour lands in that store's P&L.
export async function createPayrollRun(
  shopId: string,
  periodStart: string,
  periodEnd: string,
  lines: PayrollDraftLine[],
  cadence: PayrollRun['cadence'],
  locationId?: string | null
): Promise<PayrollRun> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('payroll_runs')
    .insert({
      shop_id: shopId,
      location_id: locationId ?? null,
      period_start: periodStart,
      period_end: periodEnd,
      cadence,
      created_by: userData.user?.id ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;

  if (lines.length > 0) {
    const { error: lineError } = await supabase.from('payroll_run_lines').insert(
      lines.map((line) => ({
        payroll_run_id: data.id,
        shop_member_id: line.shopMemberId,
        member_name: line.memberName,
        pay_type: line.payType,
        pay_rate_cents: line.payRateCents,
        hours_worked: line.hoursWorked,
        amount_cents: line.amountCents,
        warning: line.warning,
        warning_blocking: line.warningBlocking,
      }))
    );
    if (lineError) throw lineError;
  }

  return getPayrollRun(data.id);
}

export async function getPayrollRun(id: string): Promise<PayrollRun> {
  const { data, error } = await supabase.from('payroll_runs').select(SELECT_WITH_LINES).eq('id', id).single();
  if (error) throw error;
  return mapRunRow(data);
}

export async function updatePayrollRunLine(lineId: string, patch: { amountCents?: number; note?: string | null }): Promise<void> {
  const { error } = await supabase
    .from('payroll_run_lines')
    .update({
      ...(patch.amountCents !== undefined && { amount_cents: patch.amountCents }),
      ...(patch.note !== undefined && { note: patch.note }),
    })
    .eq('id', lineId);
  if (error) throw error;
}

// Only drafts should be deleted; a posted run is deleted by unposting first,
// so its generated expense goes with it rather than being orphaned.
export async function deletePayrollRun(id: string): Promise<void> {
  const { error } = await supabase.from('payroll_runs').delete().eq('id', id);
  if (error) throw error;
}

// Both go through RPCs: posting has to write the expense, set the total and
// flip the status in one locked transaction, and reject a double-post or an
// overlapping period. None of that is safe to do from the client.
export async function postPayrollRun(id: string): Promise<string> {
  const { data, error } = await supabase.rpc('post_payroll_run', { p_run_id: id });
  if (error) throw error;
  return data as string;
}

export async function unpostPayrollRun(id: string): Promise<void> {
  const { error } = await supabase.rpc('unpost_payroll_run', { p_run_id: id });
  if (error) throw error;
}
