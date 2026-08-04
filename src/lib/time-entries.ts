import { supabase } from '@/lib/supabase';
import type { TimeEntry } from '@/types/models';

function mapTimeEntryRow(row: any): TimeEntry {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id,
    shopMemberId: row.shop_member_id,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    createdAt: row.created_at,
  };
}

// The currently-open shift for a member, if any -- drives the /me clock
// widget's "Clock in" vs "Clock out" state.
export async function getOpenTimeEntry(shopMemberId: string): Promise<TimeEntry | null> {
  const { data, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('shop_member_id', shopMemberId)
    .is('clock_out', null)
    .maybeSingle();
  if (error) throw error;
  return data ? mapTimeEntryRow(data) : null;
}

// `locationId` is which store they clocked in at — required, because a shift
// worked somewhere unknown is a gap in the timesheet, and per-store labour cost
// depends on it (migration 20260815000000).
export async function clockIn(shopId: string, shopMemberId: string, locationId: string): Promise<TimeEntry> {
  const { data, error } = await supabase
    .from('time_entries')
    .insert({ shop_id: shopId, shop_member_id: shopMemberId, location_id: locationId })
    .select('*')
    .single();
  if (error) throw error;
  return mapTimeEntryRow(data);
}

export async function clockOut(entryId: string): Promise<void> {
  const { error } = await supabase.from('time_entries').update({ clock_out: new Date().toISOString() }).eq('id', entryId);
  if (error) throw error;
}

// A member's own recent shifts (self-service /me "Recent shifts").
export async function listMyTimeEntries(shopMemberId: string, sinceIso?: string): Promise<TimeEntry[]> {
  let query = supabase.from('time_entries').select('*').eq('shop_member_id', shopMemberId).order('clock_in', { ascending: false });
  if (sinceIso) query = query.gte('clock_in', sinceIso);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapTimeEntryRow);
}

// Shop-wide, optionally filtered to one member -- the Team detail pane's
// "Hours this period"/"Recent shifts" (gated on people.timesheet.view or
// people.payroll.manage at the RLS layer).
export async function listShopTimeEntries(shopId: string, opts?: { shopMemberId?: string; sinceIso?: string }): Promise<TimeEntry[]> {
  let query = supabase.from('time_entries').select('*').eq('shop_id', shopId).order('clock_in', { ascending: false });
  if (opts?.shopMemberId) query = query.eq('shop_member_id', opts.shopMemberId);
  if (opts?.sinceIso) query = query.gte('clock_in', opts.sinceIso);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapTimeEntryRow);
}

// Re-exported from shift-hours.ts, where the implementation moved so payroll
// can import it without pulling in the Supabase client. Kept exported here so
// existing callers (the Team tab) don't need to change.
export { sumDurationHours } from '@/lib/shift-hours';
