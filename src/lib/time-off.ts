import { supabase } from '@/lib/supabase';
import type { TimeOffRequest } from '@/types/models';

function mapTimeOffRow(row: any): TimeOffRequest {
  const dateRanges = row.date_ranges || [];
  // Calculate min/max dates for convenience fields
  let minDate = row.start_date;
  let maxDate = row.end_date;
  if (dateRanges.length > 0) {
    const dates = dateRanges.map((r: any) => [r.startDate, r.endDate]).flat();
    minDate = dates.length > 0 ? dates.sort()[0] : row.start_date;
    maxDate = dates.length > 0 ? dates.sort().reverse()[0] : row.end_date;
  }
  return {
    id: row.id,
    shopId: row.shop_id,
    shopMemberId: row.shop_member_id,
    startDate: minDate,
    endDate: maxDate,
    dateRanges,
    reason: row.reason,
    status: row.status,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

// Check if two date ranges overlap
function rangesOverlap(
  range1: {startDate: string; endDate: string},
  range2: {startDate: string; endDate: string}
): boolean {
  const r1Start = new Date(range1.startDate);
  const r1End = new Date(range1.endDate);
  const r2Start = new Date(range2.startDate);
  const r2End = new Date(range2.endDate);
  return r1Start <= r2End && r2Start <= r1End;
}

// Validate that dateRanges array has no overlaps
function validateDateRanges(ranges: {startDate: string; endDate: string}[]): void {
  if (ranges.length <= 1) return;
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (rangesOverlap(ranges[i], ranges[j])) {
        throw new Error(`Date ranges overlap: ${ranges[i].startDate}-${ranges[i].endDate} overlaps with ${ranges[j].startDate}-${ranges[j].endDate}`);
      }
    }
  }
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
  input: { dateRanges: {startDate: string; endDate: string}[]; reason?: string | null }
): Promise<TimeOffRequest> {
  // Validate no overlapping ranges
  validateDateRanges(input.dateRanges);
  
  // Calculate min/max for convenience fields
  const dates = input.dateRanges.map(r => [r.startDate, r.endDate]).flat().sort();
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  
  const { data, error } = await supabase
    .from('time_off_requests')
    .insert({ 
      shop_id: shopId, 
      shop_member_id: shopMemberId, 
      start_date: startDate,
      end_date: endDate,
      date_ranges: input.dateRanges,
      reason: input.reason ?? null 
    })
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

// Approved leave for the Schedule tab's on-leave warning. Deliberately not
// listShopTimeOffRequests: that goes through the table's own RLS policy,
// which is gated on people.timeoff.approve alone, so a member holding only
// people.schedule.manage would see zero rows and the warning would never
// fire. This calls a security definer RPC instead (mirrors list_shop_staff)
// that is gated on people.schedule.manage OR people.timeoff.approve and,
// because it's wider, deliberately never returns the free-text `reason` --
// see migration 20260807000000.
//
// onLeaveMemberIds (shift-hours.ts) is unit-tested and shared with other
// callers, so it stays untouched and keeps taking TimeOffRequest[]. The RPC
// only returns (shopMemberId, startDate, endDate) -- everything else here is
// filled with values that make onLeaveMemberIds' read of
// status/dateRanges/startDate/endDate/shopMemberId behave correctly; the rest
// (id, reason, requestedAt, ...) is unused by that function and never shown,
// since this result never reaches a request-detail view.
export async function listShopApprovedTimeOff(shopId: string, range: { start: string; end: string }): Promise<TimeOffRequest[]> {
  const { data, error } = await supabase.rpc('list_shop_time_off', {
    p_shop_id: shopId,
    p_start_date: range.start,
    p_end_date: range.end,
  });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: `${row.shop_member_id}-${row.start_date}-${row.end_date}`,
    shopId,
    shopMemberId: row.shop_member_id,
    startDate: row.start_date,
    endDate: row.end_date,
    dateRanges: [],
    reason: null,
    status: 'approved' as const,
    requestedAt: '',
    decidedBy: null,
    decidedAt: null,
  }));
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

// Employee cancels their own time off request (pending or approved)
export async function cancelTimeOffRequest(requestId: string): Promise<void> {
  const { error } = await supabase
    .from('time_off_requests')
    .delete()
    .eq('id', requestId);
  if (error) throw error;
}

// Employee updates their pending time off request (before approval)
export async function updateTimeOffRequest(
  requestId: string,
  input: { dateRanges: {startDate: string; endDate: string}[]; reason?: string | null }
): Promise<TimeOffRequest> {
  // Validate no overlapping ranges
  validateDateRanges(input.dateRanges);
  
  // Calculate min/max for convenience fields
  const dates = input.dateRanges.map(r => [r.startDate, r.endDate]).flat().sort();
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  
  const { data, error } = await supabase
    .from('time_off_requests')
    .update({ 
      start_date: startDate,
      end_date: endDate,
      date_ranges: input.dateRanges,
      reason: input.reason ?? null 
    })
    .eq('id', requestId)
    .select('*')
    .single();
  if (error) throw error;
  return mapTimeOffRow(data);
}
