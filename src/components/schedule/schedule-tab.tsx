import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { ShiftEditorModal } from '@/components/schedule/shift-editor-modal';
import { addDaysToDate, shiftMinutes, shiftsToCopy, startOfWeek, weekDaysFrom, type Shift, type ShiftDraft } from '@/lib/scheduling';
import { createShift, createShifts, deleteShift, listShiftsForWeek, updateShift } from '@/lib/shifts';
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

  const [monday, setMonday] = useState(() => startOfWeek(toDateColumn(new Date())));
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [selectedDay, setSelectedDay] = useState(() => toDateColumn(new Date()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ date: string; shift: Shift | null; memberId: string | null } | null>(null);
  const [timeOff, setTimeOff] = useState<Awaited<ReturnType<typeof listShopApprovedTimeOff>>>([]);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

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

  const saveShift = async (draft: ShiftDraft, note: string | null) => {
    if (!shop) return;
    if (editing?.shift) await updateShift(editing.shift.id, { date: draft.date, start: draft.start, end: draft.end, note });
    else await createShift(shop.id, draft, note);
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
      const previous = await listShiftsForWeek(shop.id, addDaysToDate(monday, -7));
      const { copy, skipped } = shiftsToCopy(previous, shifts);
      const created = await createShifts(shop.id, copy);
      // "Copied 0" alone reads as an unexplained no-op, which is the ambiguity
      // this notice exists to remove -- so an empty source week says so.
      setCopyNotice(
        previous.length === 0
          ? 'Last week had no shifts to copy.'
          : skipped === 0
            ? `Copied ${created} shift${created === 1 ? '' : 's'} from last week.`
            : `Copied ${created}, skipped ${skipped} that clashed with a shift already here.`
      );
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy last week.');
    }
  };

  const days = weekDaysFrom(monday);
  // selectedDay is only ever moved by tapping a day chip -- paging the week
  // with ‹ / › re-anchors `days` but leaves selectedDay wherever it was, so a
  // stored value from a previous week would silently point outside the week
  // now on screen. Deriving the effective day here (rather than reconciling
  // the state itself, which would need an effect the lint budget doesn't
  // allow) keeps every read of "the selected day" honest without one.
  const effectiveSelectedDay = days.includes(selectedDay) ? selectedDay : days[0];
  const shiftsFor = (memberId: string, date: string) =>
    shifts.filter((shift) => shift.shopMemberId === memberId && shift.date === date);

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
        </View>
      </View>
      {tabSwitcher}

      {error && <Text style={styles.error}>{error}</Text>}
      {copyNotice && <Text style={styles.notice}>{copyNotice}</Text>}

      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : members.length === 0 ? (
        <Text style={styles.empty}>No active staff to schedule.</Text>
      ) : compact ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dayStrip}>
            {days.map((date) => (
              <Pressable key={date} onPress={() => setSelectedDay(date)} style={[styles.dayChip, effectiveSelectedDay === date && styles.dayChipActive]}>
                <Text style={[styles.dayChipText, effectiveSelectedDay === date && styles.dayChipTextActive]}>{dayLabel(date)}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {members.map((member) => {
            const memberShifts = shiftsFor(member.id, effectiveSelectedDay);
            return (
              <Pressable key={member.id} onPress={() => setEditing({ date: effectiveSelectedDay, shift: memberShifts[0] ?? null, memberId: member.id })} style={styles.listRow}>
                <Text style={styles.memberName}>{member.fullName ?? 'Staff member'}</Text>
                <Text style={memberShifts.length === 0 ? styles.off : styles.times}>
                  {memberShifts.length === 0 ? 'Off' : memberShifts.map((s) => `${s.start}–${s.end}`).join(', ')}
                </Text>
              </Pressable>
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
            {members.map((member) => (
              <View key={member.id} style={styles.gridRow}>
                <Text style={[styles.gridCell, styles.memberName]}>{member.fullName ?? 'Staff member'}</Text>
                {days.map((date) => {
                  const cell = shiftsFor(member.id, date);
                  return (
                    <Pressable key={date} onPress={() => setEditing({ date, shift: cell[0] ?? null, memberId: member.id })}>
                      <Text style={[styles.gridCell, cell.length === 0 && styles.off]}>
                        {cell.length === 0 ? '—' : cell.map((s) => `${s.start}–${s.end}`).join('\n')}
                      </Text>
                    </Pressable>
                  );
                })}
                <Text style={[styles.gridCell, styles.total]}>
                  {totalHours(shifts.filter((shift) => shift.shopMemberId === member.id))}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
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
  dayStrip: { marginBottom: 12 },
  dayChip: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 },
  dayChipActive: { backgroundColor: '#111111' },
  dayChipText: { fontSize: 12, fontWeight: '700', color: '#444444' },
  dayChipTextActive: { color: '#FFFFFF' },
  listRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  gridRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  gridCell: { width: 104, padding: 10, fontSize: 12, color: '#111111' },
  gridHeadCell: { fontWeight: '800', color: '#999999', fontSize: 11 },
  memberName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  times: { fontSize: 12, color: '#111111' },
  off: { color: '#999999' },
  total: { fontWeight: '800' },
  empty: { fontSize: 13, color: '#999999', paddingVertical: 24, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 12 },
  notice: { fontSize: 12, fontWeight: '700', color: '#111111', marginBottom: 12 },
});
