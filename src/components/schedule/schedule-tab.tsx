import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { ExportMenu } from '@/components/export-menu';
import { BulkShiftModal } from '@/components/schedule/bulk-shift-modal';
import { ShiftEditorModal } from '@/components/schedule/shift-editor-modal';
import {
  addDaysToDate,
  membersForLocation,
  shiftMinutes,
  shiftsToCopy,
  startOfWeek,
  weekDaysFrom,
  type Shift,
  type ShiftDraft,
} from '@/lib/scheduling';
import { hasMultipleLocations } from '@/lib/location-selection';
import { SCHEDULE_EXAMPLE_ROWS, SCHEDULE_TEMPLATE_COLUMNS } from '@/lib/schedule-import';
import { createShift, createShifts, deleteShift, listShiftsForWeek, runScheduleImport, updateShift } from '@/lib/shifts';
import type { CsvColumn } from '@/lib/csv';
import { onLeaveMemberIds } from '@/lib/shift-hours';
import { listShopApprovedTimeOff } from '@/lib/time-off';
import { listStaff } from '@/lib/staff';
import { fromDateColumn, toDateColumn } from '@/lib/period';
import type { StaffMember } from '@/types/models';

function dayLabel(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}/${month}`;
}

function totalHours(shifts: Shift[]): string {
  const minutes = shifts.reduce((sum, shift) => sum + shiftMinutes(shift), 0);
  return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}h`;
}

export function ScheduleTab({ tabSwitcher }: { tabSwitcher: React.ReactNode }) {
  const { shop, locations, activeLocation } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;

  // Which store's week is on screen. null is "All stores". Defaults to the
  // active store, because planning is something you do for one counter at a
  // time -- the flat shop-wide board was unreadable once a second store
  // existed.
  const [locationId, setLocationId] = useState<string | null>(() => activeLocation?.id ?? null);
  const [monday, setMonday] = useState(() => startOfWeek(toDateColumn(new Date())));
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [selectedDay, setSelectedDay] = useState(() => toDateColumn(new Date()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ date: string; shift: Shift | null; memberId: string | null } | null>(null);
  const [timeOff, setTimeOff] = useState<Awaited<ReturnType<typeof listShopApprovedTimeOff>>>([]);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      const [weekShifts, staff, requests] = await Promise.all([
        listShiftsForWeek(shop.id, monday),
        listStaff(shop.id),
        listShopApprovedTimeOff(shop.id, { start: monday, end: addDaysToDate(monday, 6) }),
      ]);
      setShifts(weekShifts);
      setMembers(staff.filter((member) => member.active));
      setTimeOff(requests);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the schedule.');
    } finally {
      setLoading(false);
    }
  }, [shop, monday]);

  useEffect(() => { reload(); }, [reload]);

  // One draft edits in place; two or more are a split day, which is several
  // rows -- the schema has no "split shift", only shifts that share a date.
  const saveShift = async (drafts: ShiftDraft[], note: string | null) => {
    if (!shop || drafts.length === 0) return;
    if (editing?.shift) {
      const [draft] = drafts;
      await updateShift(editing.shift.id, { date: draft.date, start: draft.start, end: draft.end, note });
    } else if (drafts.length === 1) {
      await createShift(shop.id, drafts[0], note);
    } else {
      await createShifts(shop.id, drafts.map((draft) => ({ ...draft, note })));
    }
    setEditing(null);
    await reload();
  };

  const removeShift = async () => {
    if (!editing?.shift) return;
    await deleteShift(editing.shift.id);
    setEditing(null);
    await reload();
  };

  // Reports both counts rather than silently doing partial work: an owner who
  // asked to copy a week needs to know which shifts didn't make it.
  const copyLastWeek = async () => {
    if (!shop) return;
    setCopyNotice(null);
    try {
      const lastWeek = await listShiftsForWeek(shop.id, addDaysToDate(monday, -7));
      // Copies only what is on screen. Copying every store's shifts from a view
      // filtered to one store would do more than the screen shows, which is the
      // kind of surprise an undo button doesn't fix.
      const previous = locationId ? lastWeek.filter((shift) => shift.locationId === locationId) : lastWeek;
      const { copy, skipped } = shiftsToCopy(previous, visibleShifts);
      const created = await createShifts(shop.id, copy);
      const where = locationId ? ` to ${storeName(locationId)}` : '';
      // "Copied 0" alone reads as an unexplained no-op, which is the ambiguity
      // this notice exists to remove -- so an empty source week says so.
      setCopyNotice(
        previous.length === 0
          ? `Last week had no shifts${locationId ? ` at ${storeName(locationId)}` : ''} to copy.`
          : skipped === 0
            ? `Copied ${created} shift${created === 1 ? '' : 's'} from last week${where}.`
            : `Copied ${created}${where}, skipped ${skipped} that clashed with a shift already here.`
      );
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy last week.');
    }
  };

  const activeLocations = locations.filter((location) => location.active);
  const multiStore = hasMultipleLocations(locations);
  // Filtered here rather than in the query: the week is a single fetch, and
  // copy-last-week needs to reason about it as a whole.
  const visibleShifts = locationId ? shifts.filter((shift) => shift.locationId === locationId) : shifts;
  const visibleMembers = membersForLocation(members, locationId);
  const storeName = (id: string) => locations.find((location) => location.id === id)?.name ?? '';

  // Deliberately the same headers, in the same order, as
  // SCHEDULE_TEMPLATE_COLUMNS: export a week, edit it in a spreadsheet, import
  // it back. A format you can only write by hand isn't one people use.
  const exportColumns: CsvColumn<Shift>[] = [
    { header: 'Date', value: (shift) => shift.date },
    { header: 'Staff Email', value: (shift) => members.find((m) => m.id === shift.shopMemberId)?.email ?? '' },
    { header: 'Start', value: (shift) => shift.start },
    { header: 'End', value: (shift) => shift.end },
    { header: 'Store', value: (shift) => storeName(shift.locationId) },
    { header: 'Note', value: (shift) => shift.note ?? '' },
  ];

  const importConfig: ImportEntityConfig<ShiftDraft> | null =
    shop && members.length > 0
      ? {
          title: 'schedule',
          filenamePrefix: 'schedule',
          templateColumns: SCHEDULE_TEMPLATE_COLUMNS,
          exampleRows: SCHEDULE_EXAMPLE_ROWS,
          run: (parsed) => runScheduleImport(shop.id, parsed, { members, locations }),
          unitLabel: 'shift',
        }
      : null;

  const days = weekDaysFrom(monday);
  // selectedDay is only ever moved by tapping a day chip -- paging the week
  // with ‹ / › re-anchors `days` but leaves selectedDay wherever it was, so a
  // stored value from a previous week would silently point outside the week
  // now on screen. Deriving the effective day here (rather than reconciling
  // the state itself, which would need an effect the lint budget doesn't
  // allow) keeps every read of "the selected day" honest without one.
  const effectiveSelectedDay = days.includes(selectedDay) ? selectedDay : days[0];
  const shiftsFor = (memberId: string, date: string) =>
    visibleShifts.filter((shift) => shift.shopMemberId === memberId && shift.date === date);
  // Under "All stores" a bare 09:00–17:00 doesn't say where, and two stores'
  // rows sit side by side. Under one store the name is on the filter chip
  // already, so repeating it in every cell is noise.
  const shiftLabel = (shift: Shift) =>
    `${shift.start}–${shift.end}${!locationId && multiStore ? ` · ${storeName(shift.locationId)}` : ''}`;

  return (
    <View>
      <View style={styles.header}>
        <Text style={styles.title}>Schedule</Text>
        <View style={styles.weekNav}>
          <Pressable onPress={() => setMonday(addDaysToDate(monday, -7))} style={styles.navButton}>
            <Text style={styles.navText}>‹</Text>
          </Pressable>
          <Text style={styles.weekLabel}>{dayLabel(days[0])} – {dayLabel(days[6])}</Text>
          <Pressable onPress={() => setMonday(addDaysToDate(monday, 7))} style={styles.navButton}>
            <Text style={styles.navText}>›</Text>
          </Pressable>
          <Pressable onPress={() => setMonday(startOfWeek(toDateColumn(new Date())))} style={styles.navButton}>
            <Text style={styles.navText}>Today</Text>
          </Pressable>
          <Pressable onPress={copyLastWeek} style={styles.navButton}>
            <Text style={styles.navText}>Copy last week</Text>
          </Pressable>
          <ExportMenu
            rows={visibleShifts}
            columns={exportColumns}
            title="Schedule"
            subtitle={`${dayLabel(days[0])} – ${dayLabel(days[6])}${locationId ? ` · ${storeName(locationId)}` : ''}`}
            filenamePrefix="schedule"
          />
          <Pressable onPress={() => setShowImportModal(true)} style={styles.navButton}>
            <Text style={styles.navText}>Import</Text>
          </Pressable>
          <Pressable onPress={() => setShowBulkModal(true)} style={styles.navButton}>
            <Text style={styles.navText}>+ Add shifts</Text>
          </Pressable>
        </View>
      </View>
      {tabSwitcher}

      {/* Only when there is a choice to make -- a single-store business has one
          answer and this row would say nothing. */}
      {multiStore && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.storeStrip}>
          <Pressable onPress={() => setLocationId(null)} style={[styles.storeChip, locationId === null && styles.storeChipActive]}>
            <Text style={[styles.storeChipText, locationId === null && styles.storeChipTextActive]}>All stores</Text>
          </Pressable>
          {activeLocations.map((location) => (
            <Pressable
              key={location.id}
              onPress={() => setLocationId(location.id)}
              style={[styles.storeChip, locationId === location.id && styles.storeChipActive]}
            >
              <Text style={[styles.storeChipText, locationId === location.id && styles.storeChipTextActive]}>{location.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
      {copyNotice && <Text style={styles.notice}>{copyNotice}</Text>}

      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : visibleMembers.length === 0 ? (
        <Text style={styles.empty}>
          {members.length === 0
            ? 'No active staff to schedule.'
            : `No staff can work at ${locationId ? storeName(locationId) : 'this store'} yet — assign someone to it in Team.`}
        </Text>
      ) : compact ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dayStrip}>
            {days.map((date) => (
              <Pressable key={date} onPress={() => setSelectedDay(date)} style={[styles.dayChip, effectiveSelectedDay === date && styles.dayChipActive]}>
                <Text style={[styles.dayChipText, effectiveSelectedDay === date && styles.dayChipTextActive]}>{dayLabel(date)}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {visibleMembers.map((member) => {
            const memberShifts = shiftsFor(member.id, effectiveSelectedDay);
            return (
              <View key={member.id} style={styles.listRow}>
                <Text style={styles.memberName}>{member.fullName ?? 'Staff member'}</Text>
                {/* Each block is its own tap target, so a split day can be
                    edited one half at a time -- and `+ Add` is what makes the
                    second half reachable at all. */}
                <View style={styles.listRowRight}>
                  {memberShifts.length === 0 ? (
                    <Pressable onPress={() => setEditing({ date: effectiveSelectedDay, shift: null, memberId: member.id })}>
                      <Text style={styles.off}>Off</Text>
                    </Pressable>
                  ) : (
                    memberShifts.map((shift) => (
                      <Pressable key={shift.id} onPress={() => setEditing({ date: effectiveSelectedDay, shift, memberId: member.id })}>
                        <Text style={styles.times}>{shiftLabel(shift)}</Text>
                      </Pressable>
                    ))
                  )}
                  <Pressable
                    accessibilityLabel={`Add a shift for ${member.fullName ?? 'this person'}`}
                    onPress={() => setEditing({ date: effectiveSelectedDay, shift: null, memberId: member.id })}
                    hitSlop={8}
                  >
                    <Text style={styles.addShift}>+</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </>
      ) : (
        <ScrollView horizontal>
          <View>
            <View style={styles.gridRow}>
              <Text style={[styles.gridCell, styles.gridHeadCell]}>Staff</Text>
              {days.map((date) => (
                <Text key={date} style={[styles.gridCell, styles.gridHeadCell]}>{dayLabel(date)}</Text>
              ))}
              <Text style={[styles.gridCell, styles.gridHeadCell]}>Total</Text>
            </View>
            {visibleMembers.map((member) => (
              <View key={member.id} style={styles.gridRow}>
                <Text style={[styles.gridCell, styles.memberName]}>{member.fullName ?? 'Staff member'}</Text>
                {days.map((date) => {
                  const cell = shiftsFor(member.id, date);
                  return (
                    <View key={date} style={[styles.gridCell, styles.gridCellStack]}>
                      {cell.map((shift) => (
                        <Pressable key={shift.id} onPress={() => setEditing({ date, shift, memberId: member.id })}>
                          <Text style={styles.times}>{shiftLabel(shift)}</Text>
                        </Pressable>
                      ))}
                      {/* Tapping an occupied cell used to edit its FIRST shift,
                          which made a second block on the same day
                          unreachable -- this is the whole of split-day entry. */}
                      <Pressable
                        accessibilityLabel={`Add a shift for ${member.fullName ?? 'this person'}`}
                        onPress={() => setEditing({ date, shift: null, memberId: member.id })}
                        hitSlop={6}
                      >
                        <Text style={cell.length === 0 ? styles.off : styles.addShift}>{cell.length === 0 ? '—' : '+ add'}</Text>
                      </Pressable>
                    </View>
                  );
                })}
                <Text style={[styles.gridCell, styles.total]}>
                  {totalHours(visibleShifts.filter((shift) => shift.shopMemberId === member.id))}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      {showBulkModal && (
        <BulkShiftModal
          visible
          days={days}
          members={visibleMembers}
          locations={activeLocations}
          seedLocationId={locationId}
          seedDate={effectiveSelectedDay}
          // Every stored shift, not just the visible store's: someone cannot be
          // in two stores at once, so a clash is a clash wherever it is.
          existingShifts={shifts}
          onClose={() => setShowBulkModal(false)}
          onSave={async (drafts) => {
            if (!shop) return;
            await createShifts(shop.id, drafts);
            setShowBulkModal(false);
            await reload();
          }}
        />
      )}

      {importConfig && (
        <CsvImportModal visible={showImportModal} onClose={() => setShowImportModal(false)} config={importConfig} onImported={reload} />
      )}

      {editing && (
        <ShiftEditorModal
          // Keyed on the edit target so switching targets remounts rather than
          // keeping the previous shift's times: the modal seeds its state from
          // `existing` with useState, which only reads it on first mount. This
          // matches invoices-tab, cash-budgets-tab, expenses-tab and
          // taxonomy-manage-modal, which all key their editors for this reason.
          key={editing.shift ? editing.shift.id : `new-${editing.date}-${editing.memberId}`}
          visible
          date={editing.date}
          members={members}
          existing={editing.shift}
          seedMemberId={editing.memberId}
          seedLocationId={locationId}
          locations={locations.filter((location) => location.active)}
          context={{
            // A placeholder: the modal overrides this with the hours of the
            // store the shift is actually assigned to, which is the only
            // reading that means anything once two stores differ.
            hours: activeLocation?.openingHours ?? {},
            onLeave: onLeaveMemberIds(timeOff, fromDateColumn(editing.date)),
            sameDayShifts: shifts.filter((shift) => shift.date === editing.date),
          }}
          onClose={() => setEditing(null)}
          onSave={saveShift}
          onDelete={removeShift}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' },
  title: { fontSize: 20, fontWeight: '800', color: '#111111' },
  weekNav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navButton: { backgroundColor: '#F2F2F2', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8 },
  navText: { fontSize: 13, fontWeight: '800', color: '#111111' },
  weekLabel: { fontSize: 13, fontWeight: '700', color: '#111111', minWidth: 104, textAlign: 'center' },
  storeStrip: { marginBottom: 12 },
  storeChip: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 },
  storeChipActive: { backgroundColor: '#111111' },
  storeChipText: { fontSize: 12, fontWeight: '700', color: '#444444' },
  storeChipTextActive: { color: '#FFFFFF' },
  dayStrip: { marginBottom: 12 },
  dayChip: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 },
  dayChipActive: { backgroundColor: '#111111' },
  dayChipText: { fontSize: 12, fontWeight: '700', color: '#444444' },
  dayChipTextActive: { color: '#FFFFFF' },
  listRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  listRowRight: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
  addShift: { fontSize: 12, fontWeight: '800', color: '#666666' },
  gridRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  gridCell: { width: 104, padding: 10, fontSize: 12, color: '#111111' },
  gridCellStack: { gap: 4 },
  gridHeadCell: { fontWeight: '800', color: '#999999', fontSize: 11 },
  memberName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  times: { fontSize: 12, color: '#111111' },
  off: { color: '#999999' },
  total: { fontWeight: '800' },
  empty: { fontSize: 13, color: '#999999', paddingVertical: 24, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 12 },
  notice: { fontSize: 12, fontWeight: '700', color: '#111111', marginBottom: 12 },
});
