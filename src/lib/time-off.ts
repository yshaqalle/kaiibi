import { supabase } from '@/lib/supabase';
import type { TimeOffRequest } from '@/types/models';

function mapTimeOffRow(row: any): TimeOffRequest {
  return {
    id: row.id,
    shopId: row.shop_id,
    shopMemberId: row.shop_member_id,
    startDate: row.start_date,
    endDate: row.end_date,
    reason: row.reason,
    status: row.status,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

export async function listMyTimeOffRequests(shopMemberId: string): Promise<TimeOffRequest[]> {
  const { data, error } = await supabase
    .from('time_off_requests')
    .select('*')
    .eq('shop_member_id', shopMemberId)
    .order('requested_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapTimeOffRow);
}

export async function requestTimeOff(
  shopId: string,
  shopMemberId: string,
  input: { startDate: string; endDate: string; reason?: string | null }
): Promise<TimeOffRequest> {
  const { data, error } = await supabase
    .from('time_off_requests')
    .insert({ shop_id: shopId, shop_member_id: shopMemberId, start_date: input.startDate, end_date: input.endDate, reason: input.reason ?? null })
    .select('*')
    .single();
  if (error) throw error;
  return mapTimeOffRow(data);
}

// Shop-wide, optionally filtered by status -- the Team tab's approval list
// (gated on people.timeoff.approve at the RLS layer).
export async function listShopTimeOffRequests(shopId: string, opts?: { status?: TimeOffRequest['status'] }): Promise<TimeOffRequest[]> {
  let query = supabase.from('time_off_requests').select('*').eq('shop_id', shopId).order('requested_at', { ascending: false });
  if (opts?.status) query = query.eq('status', opts.status);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapTimeOffRow);
}

// Approve/deny -- decided_by is the calling (approver) user, read from the
// current session rather than passed in, so a caller can't misattribute a
// decision to someone else.
export async function decideTimeOffRequest(requestId: string, decision: 'approved' | 'denied'): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const { error } = await supabase
    .from('time_off_requests')
    .update({ status: decision, decided_by: userData.user?.id ?? null, decided_at: new Date().toISOString() })
    .eq('id', requestId);
  if (error) throw error;
}
