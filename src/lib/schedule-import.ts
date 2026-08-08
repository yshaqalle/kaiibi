import type { ParsedCsv } from '@/lib/csv';
import type { RejectedRow } from '@/lib/import-shared';
import { clashesWith, type Shift, type ShiftDraft } from '@/lib/scheduling';
import { isValidTime } from '@/lib/store-hours';
import type { ShopLocation, StaffMember } from '@/types/models';

// Building a rota in a spreadsheet and uploading it, which is how a manager
// with twelve staff actually plans a week.
//
// This module is PURE -- no Supabase import -- so it loads under Jest, the same
// split scheduling.ts keeps from shifts.ts. The half that reads and writes the
// database (runScheduleImport) lives in shifts.ts and calls parseScheduleRows
// here.

export const SCHEDULE_TEMPLATE_COLUMNS: { header: string; required: boolean }[] = [
  { header: 'Date', required: true },
  // The parser has always accepted a name as the fallback identity; listing it
  // makes that visible, and a file of names reads like a rota to the person
  // filling it in, where a file of email addresses reads like a database.
  { header: 'Staff Name', required: false },
  { header: 'Staff Email', required: true },
  { header: 'Start', required: true },
  { header: 'End', required: true },
  // Required in substance for a multi-store shop, but not marked so: a
  // single-store business has one answer and shouldn't be made to type it.
  { header: 'Store', required: false },
  { header: 'Note', required: false },
];

// The rota a manager actually wants to be handed: their own people, against the
// week they are looking at, with the dates and the store already written in.
// All they add is times, and only on the days someone works -- the blank ones
// are skipped by parseScheduleRows rather than reported as errors.
//
// Every column this fills is a column that would otherwise be typed by hand,
// and Date, Staff Email and Store are exactly the three that produce rejections
// when they are.
export function scheduleTemplateRows(
  members: readonly StaffMember[],
  days: readonly string[],
  storeName: string
): Record<string, string>[] {
  // Grouped by person rather than by day: filling this in is one person's week
  // at a time, so their seven rows belong together.
  return members
    .filter((member) => member.active)
    .flatMap((member) =>
      days.map((date) => ({
        Date: date,
        'Staff Name': member.fullName ?? '',
        'Staff Email': member.email ?? '',
        Start: '',
        End: '',
        Store: storeName,
        Note: '',
      }))
    );
}

// The fallback when a shop has nobody to build a template from, and the shape
// the format is documented by.
export const SCHEDULE_EXAMPLE_ROWS: Record<string, string>[] = [
  { Date: '2026-08-10', 'Staff Email': 'hamse@example.com', Start: '09:00', End: '17:00', Store: 'Main', Note: '' },
  // Two rows, same person, same day: that is a split day. No special syntax,
  // which is what lets an exported week be re-imported unchanged.
  { Date: '2026-08-11', 'Staff Email': 'hamse@example.com', Start: '09:00', End: '13:00', Store: 'Main', Note: 'morning' },
  { Date: '2026-08-11', 'Staff Email': 'hamse@example.com', Start: '17:00', End: '21:00', Store: 'Main', Note: 'evening' },
];

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeCell(text: string | undefined): string {
  return (text ?? '').trim();
}

// The date column is the one place a spreadsheet will fight back: Excel loves
// to hand back 10/08/2026 or a serial number. Rejecting with the expected shape
// spelled out is more use than "invalid date".
function isValidDateColumn(text: string): boolean {
  if (!DATE_PATTERN.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00`);
  return !Number.isNaN(parsed.getTime()) && text === parsed.toISOString().slice(0, 10);
}

export type ScheduleImportContext = {
  members: StaffMember[];
  locations: ShopLocation[];
  // Everything already stored for the dates being imported, so a row that would
  // double-book someone is rejected rather than written.
  existingShifts: Shift[];
};

export function parseScheduleRows(
  parsed: ParsedCsv,
  { members, locations, existingShifts }: ScheduleImportContext
): { drafts: ShiftDraft[]; rejected: RejectedRow[] } {
  const activeMembers = members.filter((member) => member.active);
  const byEmail = new Map(activeMembers.filter((m) => m.email).map((m) => [m.email!.toLowerCase(), m]));

  // Name is the fallback identity, and only when it is unambiguous -- two
  // people called Hodan Ali means the file has to say which, not that the
  // import guesses.
  const byName = new Map<string, StaffMember[]>();
  for (const member of activeMembers) {
    const key = (member.fullName ?? '').trim().toLowerCase();
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), member]);
  }

  const activeLocations = locations.filter((location) => location.active);
  const byStoreName = new Map(activeLocations.map((location) => [location.name.trim().toLowerCase(), location]));
  const soleLocation = activeLocations.find((location) => location.isPrimary) ?? activeLocations[0] ?? null;

  const drafts: ShiftDraft[] = [];
  const rejected: RejectedRow[] = [];

  parsed.rows.forEach((raw, i) => {
    const row = i + 2; // header occupies row 1 in the uploaded file
    const reject = (reason: string) => rejected.push({ row, reason, data: raw });

    const date = normalizeCell(raw['Date']);
    const email = normalizeCell(raw['Staff Email']).toLowerCase();
    const name = normalizeCell(raw['Staff Name'] ?? raw['Name']);
    const start = normalizeCell(raw['Start']);
    const end = normalizeCell(raw['End']);
    const storeName = normalizeCell(raw['Store']);
    const note = normalizeCell(raw['Note']);

    // A pre-filled template is a grid -- everyone against every day of the week
    // -- and the days a person is not working are left empty. Empty is an
    // answer, not a mistake: twelve people over a week is 84 rows, and a
    // manager who fills twenty of them must see twenty imported, not sixty-four
    // rejections. Half-filled still falls through to the time checks below,
    // because a start with no end is someone who got distracted.
    if (!start && !end) return;

    if (!date) return reject('Date is required.');
    if (!isValidDateColumn(date)) return reject(`Date "${date}" is not a real date in YYYY-MM-DD form (e.g. 2026-08-10).`);

    let member: StaffMember | undefined;
    if (email) {
      member = byEmail.get(email);
      if (!member) return reject(`No active staff member has the email "${email}".`);
    } else if (name) {
      const matches = byName.get(name.toLowerCase()) ?? [];
      if (matches.length === 0) return reject(`No active staff member is called "${name}".`);
      if (matches.length > 1) return reject(`More than one staff member is called "${name}" — use their email instead.`);
      member = matches[0];
    } else {
      return reject('Staff Email is required.');
    }

    if (!isValidTime(start)) return reject(`Start "${start}" is not a 24-hour time like 09:00.`);
    if (!isValidTime(end)) return reject(`End "${end}" is not a 24-hour time like 17:00.`);
    // Times are zero-padded HH:MM, so string comparison is chronological.
    if (end <= start) return reject('End must be after Start. Overnight shifts are not supported.');

    let location: ShopLocation | null;
    if (storeName) {
      location = byStoreName.get(storeName.toLowerCase()) ?? null;
      if (!location) return reject(`No active store is called "${storeName}".`);
    } else if (activeLocations.length > 1) {
      return reject('Store is required — this shop has more than one store, so the row has to say which.');
    } else {
      location = soleLocation;
      if (!location) return reject('This shop has no active store to schedule against.');
    }

    // An empty locationIds means every store (migration 20260814000000), so
    // only an explicit assignment can exclude someone.
    if (member.locationIds.length > 0 && !member.locationIds.includes(location.id)) {
      return reject(`${member.fullName ?? 'This person'} is not assigned to ${location.name}.`);
    }

    const draft: ShiftDraft = {
      shopMemberId: member.id,
      locationId: location.id,
      date,
      start,
      end,
      note: note || null,
    };

    // Against the stored week AND against rows already accepted from this file
    // -- the second of two colliding rows can't see the first in the database.
    if (clashesWith(draft, existingShifts)) {
      return reject(`${member.fullName ?? 'This person'} already has a shift overlapping ${start}–${end} on ${date}.`);
    }
    if (clashesWith(draft, drafts)) {
      return reject(`This row overlaps another row in the file for ${member.fullName ?? 'the same person'} on ${date}.`);
    }

    drafts.push(draft);
  });

  return { drafts, rejected };
}
