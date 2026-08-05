import type { ImportReport } from '@/lib/import-shared';
import { DATE_PATTERN, normalizeCell, parseScheduleRows, type ScheduleImportContext } from '@/lib/schedule-import';
import { addDaysToDate, startOfWeek, type Shift, type ShiftDraft } from '@/lib/scheduling';
import { supabase } from '@/lib/supabase';
import type { ParsedCsv } from '@/lib/csv';

// Data access for shifts. The validation and week arithmetic live in
// scheduling.ts so they stay testable without the Supabase client.

function mapShiftRow(row: any): Shift {
  return {
    id: row.id,
    shopId: row.shop_id,
    shopMemberId: row.shop_member_id,
    locationId: row.location_id,
    date: row.shift_date,
    start: row.start_time,
    end: row.end_time,
    note: row.note,
  };
}

// Sunday is the seventh day, so the range ends six days after the Monday.
export async function listShiftsForWeek(shopId: string, monday: string): Promise<Shift[]> {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('shop_id', shopId)
    .gte('shift_date', monday)
    .lte('shift_date', addDaysToDate(monday, 6))
    .order('shift_date', { ascending: true })
    .order('start_time', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapShiftRow);
}

// The /me view. Goes through the "read own shifts" policy, so it needs no
// permission -- an ordinary cashier can see their own rota.
export async function listMyShifts(shopMemberId: string, fromDate: string): Promise<Shift[]> {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('shop_member_id', shopMemberId)
    .gte('shift_date', fromDate)
    .order('shift_date', { ascending: true })
    .order('start_time', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapShiftRow);
}

export async function createShift(shopId: string, draft: ShiftDraft, note: string | null): Promise<Shift> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('shifts')
    .insert({
      shop_id: shopId,
      shop_member_id: draft.shopMemberId,
      location_id: draft.locationId,
      shift_date: draft.date,
      start_time: draft.start,
      end_time: draft.end,
      note,
      created_by: userData.user?.id ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapShiftRow(data);
}

export async function updateShift(
  id: string,
  patch: { date?: string; start?: string; end?: string; note?: string | null }
): Promise<void> {
  const { error, count } = await supabase
    .from('shifts')
    .update(
      {
        ...(patch.date !== undefined && { shift_date: patch.date }),
        ...(patch.start !== undefined && { start_time: patch.start }),
        ...(patch.end !== undefined && { end_time: patch.end }),
        ...(patch.note !== undefined && { note: patch.note }),
        updated_at: new Date().toISOString(),
      },
      { count: 'exact' }
    )
    .eq('id', id);
  if (error) throw error;
  // RLS filters an update to zero rows without raising, so without the count a
  // policy-blocked write reads as success -- same guard as updateStaffPay.
  if (count === 0) throw new Error('Could not save this shift — you may no longer have permission to change the schedule.');
}

export async function deleteShift(id: string): Promise<void> {
  const { error, count } = await supabase.from('shifts').delete({ count: 'exact' }).eq('id', id);
  if (error) throw error;
  if (count === 0) throw new Error('Could not delete this shift — you may no longer have permission to change the schedule.');
}

// Batch writes: copy-last-week, the bulk editor, split days and CSV import all
// land here in one insert. Returns how many rows landed so the caller can
// report it alongside the skipped count.
//
// `note` travels with the draft. Copy-last-week leaves it unset (a note
// describes the shift it was written for), the others set it from what the
// user typed.
export async function createShifts(shopId: string, drafts: ShiftDraft[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('shifts')
    .insert(
      drafts.map((draft) => ({
        shop_id: shopId,
        shop_member_id: draft.shopMemberId,
        location_id: draft.locationId,
        shift_date: draft.date,
        start_time: draft.start,
        end_time: draft.end,
        note: draft.note ?? null,
        created_by: userData.user?.id ?? null,
      }))
    )
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

// A week's rota built in a spreadsheet. Reads the weeks the file touches so
// clashes are checked against what is actually stored, hands the rows to the
// pure parser in schedule-import.ts, then writes the survivors in one insert.
//
// `accepted` is ShiftDraft rather than Shift: createShifts reports a count, and
// the report only needs to say how many landed.
export async function runScheduleImport(
  shopId: string,
  parsed: ParsedCsv,
  context: Omit<ScheduleImportContext, 'existingShifts'>
): Promise<ImportReport<ShiftDraft>> {
  const dates = parsed.rows.map((raw) => normalizeCell(raw['Date'])).filter((date) => DATE_PATTERN.test(date));
  const existingShifts = await fetchShiftsCovering(shopId, dates);

  const { drafts, rejected } = parseScheduleRows(parsed, { ...context, existingShifts });
  if (drafts.length === 0) return { accepted: [], rejected };

  const created = await createShifts(shopId, drafts);
  // The batch is one statement, so a short count means the database refused
  // some of it -- reporting rows as imported when they weren't is worse than
  // failing loudly.
  if (created !== drafts.length) {
    throw new Error(`Only ${created} of ${drafts.length} shifts were saved. Check the schedule and re-import what is missing.`);
  }
  return { accepted: drafts, rejected };
}

// listShiftsForWeek is the read we have, so dates are bucketed into the Mondays
// they belong to and each week is fetched once -- a file covering one week
// costs one query, not one per row.
async function fetchShiftsCovering(shopId: string, dates: string[]): Promise<Shift[]> {
  const mondays = [...new Set(dates.map((date) => startOfWeek(date)))];
  const weeks = await Promise.all(mondays.map((monday) => listShiftsForWeek(shopId, monday)));
  return weeks.flat();
}
