import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { addDaysToDate, shiftMinutes, startOfWeek, weekDaysFrom, type Shift } from '@/lib/scheduling';
import { listShiftsForWeek } from '@/lib/shifts';
import { listStaff } from '@/lib/staff';
import { toDateColumn } from '@/lib/period';
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
  const { shop } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;

  const [monday, setMonday] = useState(() => startOfWeek(toDateColumn(new Date())));
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [selectedDay, setSelectedDay] = useState(() => toDateColumn(new Date()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      const [weekShifts, staff] = await Promise.all([listShiftsForWeek(shop.id, monday), listStaff(shop.id)]);
      setShifts(weekShifts);
      setMembers(staff.filter((member) => member.active));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the schedule.');
    } finally {
      setLoading(false);
    }
  }, [shop, monday]);

  useEffect(() => { reload(); }, [reload]);

  const days = weekDaysFrom(monday);
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
        </View>
      </View>
      {tabSwitcher}

      {error && <Text style={styles.error}>{error}</Text>}

      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : members.length === 0 ? (
        <Text style={styles.empty}>No active staff to schedule.</Text>
      ) : compact ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dayStrip}>
            {days.map((date) => (
              <Pressable key={date} onPress={() => setSelectedDay(date)} style={[styles.dayChip, selectedDay === date && styles.dayChipActive]}>
                <Text style={[styles.dayChipText, selectedDay === date && styles.dayChipTextActive]}>{dayLabel(date)}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {members.map((member) => {
            const memberShifts = shiftsFor(member.id, selectedDay);
            return (
              <View key={member.id} style={styles.listRow}>
                <Text style={styles.memberName}>{member.fullName ?? 'Staff member'}</Text>
                <Text style={memberShifts.length === 0 ? styles.off : styles.times}>
                  {memberShifts.length === 0 ? 'Off' : memberShifts.map((s) => `${s.start}–${s.end}`).join(', ')}
                </Text>
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
            {members.map((member) => (
              <View key={member.id} style={styles.gridRow}>
                <Text style={[styles.gridCell, styles.memberName]}>{member.fullName ?? 'Staff member'}</Text>
                {days.map((date) => {
                  const cell = shiftsFor(member.id, date);
                  return (
                    <Text key={date} style={[styles.gridCell, cell.length === 0 && styles.off]}>
                      {cell.length === 0 ? '—' : cell.map((s) => `${s.start}–${s.end}`).join('\n')}
                    </Text>
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
});
