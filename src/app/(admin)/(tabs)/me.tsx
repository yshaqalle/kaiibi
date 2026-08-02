import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { clockIn, clockOut, getOpenTimeEntry, listMyTimeEntries, sumDurationHours } from '@/lib/time-entries';
import { listMyTimeOffRequests, requestTimeOff } from '@/lib/time-off';
import type { StaffMember, TimeEntry, TimeOffRequest } from '@/types/models';

export default function MeScreen() {
  const { shop, profile, myMembership } = useAuth();

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{profile?.role === 'admin' ? 'Me' : (myMembership?.fullName ?? 'Me')}</Text>
        {myMembership && (
          <Text style={styles.subtitle}>
            {myMembership.roleName}
            {myMembership.hireDate ? ` · joined ${new Date(myMembership.hireDate).toLocaleDateString()}` : ''}
          </Text>
        )}

        {!shop ? null : myMembership ? (
          <StaffSelfService shopId={shop.id} member={myMembership} />
        ) : (
          <Card style={styles.ownerCard}>
            <Text style={styles.ownerText}>You&apos;re the shop owner — clock in/out and time-off tracking are for your team, not you.</Text>
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StaffSelfService({ shopId, member }: { shopId: string; member: StaffMember }) {
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [requests, setRequests] = useState<TimeOffRequest[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [clocking, setClocking] = useState(false);

  const reload = useCallback(async () => {
    const since = new Date();
    since.setDate(1);
    since.setHours(0, 0, 0, 0);
    const [open, myEntries, myRequests] = await Promise.all([
      getOpenTimeEntry(member.id),
      listMyTimeEntries(member.id, since.toISOString()),
      listMyTimeOffRequests(member.id),
    ]);
    setOpenEntry(open);
    setEntries(myEntries);
    setRequests(myRequests);
  }, [member.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Keeps "Xh Ym today" ticking while a shift is open -- 30s is frequent
  // enough to feel live without re-rendering every second for something
  // nobody's staring at continuously.
  useEffect(() => {
    if (!openEntry) return;
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, [openEntry]);

  const toggleClock = async () => {
    setClocking(true);
    try {
      if (openEntry) await clockOut(openEntry.id);
      else await clockIn(shopId, member.id);
      await reload();
    } finally {
      setClocking(false);
    }
  };

  const elapsedLabel = useMemo(() => {
    if (!openEntry) return null;
    const ms = now - new Date(openEntry.clockIn).getTime();
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m today`;
  }, [openEntry, now]);

  const hoursThisPeriod = sumDurationHours(entries);

  return (
    <View>
      <Card style={styles.clockCard}>
        <Text style={styles.clockStatus}>
          {openEntry ? `Clocked in since ${new Date(openEntry.clockIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not clocked in'}
        </Text>
        {elapsedLabel && <Text style={styles.clockElapsed}>{elapsedLabel}</Text>}
        <Pressable onPress={toggleClock} disabled={clocking} style={[styles.clockButton, clocking && styles.clockButtonDisabled]}>
          <Text style={styles.clockButtonText}>{clocking ? 'Working…' : openEntry ? 'Clock out' : 'Clock in'}</Text>
        </Pressable>
      </Card>

      <View style={styles.tiles}>
        <StatTile value={member.hireDate ? new Date(member.hireDate).toLocaleDateString() : '—'} label="Hire date" />
        <StatTile value={member.payType ? member.payType[0].toUpperCase() + member.payType.slice(1) : '—'} label="Pay type" />
        <StatTile value={member.payRateCents != null ? formatCents(member.payRateCents) : '—'} label="Pay rate" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>RECENT SHIFTS</Text>
        {entries.length === 0 ? (
          <Text style={styles.empty}>No shifts logged this period.</Text>
        ) : (
          entries.slice(0, 8).map((e) => (
            <View key={e.id} style={styles.shiftRow}>
              <Text style={styles.shiftDate}>
                {new Date(e.clockIn).toLocaleDateString()} · {new Date(e.clockIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                {e.clockOut ? `–${new Date(e.clockOut).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' (on shift)'}
              </Text>
              <Text style={styles.shiftDuration}>{e.clockOut ? `${sumDurationHours([e]).toFixed(1)}h` : '—'}</Text>
            </View>
          ))
        )}
        <Text style={styles.periodTotal}>{hoursThisPeriod.toFixed(1)}h logged this period</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeadRow}>
          <Text style={styles.sectionTitle}>TIME OFF</Text>
          <Pressable onPress={() => setShowRequestModal(true)}>
            <Text style={styles.sectionLink}>Request →</Text>
          </Pressable>
        </View>
        {requests.length === 0 ? (
          <Text style={styles.empty}>No requests yet.</Text>
        ) : (
          requests.map((r) => (
            <View key={r.id} style={styles.reqRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.reqRange}>
                  {r.startDate} – {r.endDate}
                </Text>
                {r.reason && <Text style={styles.reqReason}>{r.reason}</Text>}
              </View>
              <Badge
                label={r.status === 'pending' ? 'Pending' : r.status === 'approved' ? 'Approved' : 'Denied'}
                tone={r.status === 'pending' ? 'warning' : r.status === 'approved' ? 'success' : 'danger'}
              />
            </View>
          ))
        )}
      </View>

      <RequestTimeOffModal
        visible={showRequestModal}
        onClose={() => setShowRequestModal(false)}
        onSubmit={async (input) => {
          await requestTimeOff(shopId, member.id, input);
          await reload();
          setShowRequestModal(false);
        }}
      />
    </View>
  );
}

function RequestTimeOffModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (input: { startDate: string; endDate: string; reason?: string | null }) => Promise<void>;
}) {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setStartDate('');
      setEndDate('');
      setReason('');
      setError(null);
    }
  }, [visible]);

  const submit = async () => {
    if (!startDate.trim() || !endDate.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ startDate: startDate.trim(), endDate: endDate.trim(), reason: reason.trim() || null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit this request.');
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>Request time off</Text>
            <View style={modalStyles.headerActions}>
              <Pressable
                onPress={submit}
                disabled={saving || !startDate.trim() || !endDate.trim()}
                style={[modalStyles.addButton, (saving || !startDate.trim() || !endDate.trim()) && modalStyles.buttonDisabled]}
              >
                <Text style={modalStyles.addButtonText}>{saving ? 'Sending…' : 'Send'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={modalStyles.close}>
                <Text style={modalStyles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>
          <Text style={modalStyles.fieldLabel}>START DATE (YYYY-MM-DD)</Text>
          <TextInput value={startDate} onChangeText={setStartDate} placeholder="2026-08-05" placeholderTextColor="#999999" style={modalStyles.input} />
          <Text style={[modalStyles.fieldLabel, { marginTop: 10 }]}>END DATE (YYYY-MM-DD)</Text>
          <TextInput value={endDate} onChangeText={setEndDate} placeholder="2026-08-09" placeholderTextColor="#999999" style={modalStyles.input} />
          <Text style={[modalStyles.fieldLabel, { marginTop: 10 }]}>REASON (OPTIONAL)</Text>
          <TextInput value={reason} onChangeText={setReason} placeholder="e.g. Family event" placeholderTextColor="#999999" style={modalStyles.input} />
          {error && <Text style={modalStyles.error}>{error}</Text>}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 60 },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: '#999999', fontSize: 12, marginTop: 3, marginBottom: 20 },
  ownerCard: { padding: 18, marginTop: 10 },
  ownerText: { color: '#666666', fontSize: 13, lineHeight: 19 },
  clockCard: { padding: 20, alignItems: 'center', marginBottom: 20 },
  clockStatus: { fontSize: 11.5, fontWeight: '700', color: '#2E7D46', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 4 },
  clockElapsed: { fontSize: 26, fontWeight: '800', color: '#111111', letterSpacing: -0.5, marginBottom: 14 },
  clockButton: { backgroundColor: '#111111', borderRadius: 999, paddingHorizontal: 26, paddingVertical: 11 },
  clockButtonDisabled: { opacity: 0.6 },
  clockButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  tiles: { flexDirection: 'row', gap: 9, marginBottom: 20 },
  section: { marginBottom: 20 },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitle: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, color: '#999999', marginBottom: 8 },
  sectionLink: { fontSize: 11.5, fontWeight: '700', color: '#B23B4E' },
  empty: { color: '#999999', fontSize: 13 },
  shiftRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  shiftDate: { fontSize: 12, color: '#666666' },
  shiftDuration: { fontSize: 12, fontWeight: '700', color: '#111111' },
  periodTotal: { fontSize: 11.5, color: '#999999', marginTop: 8 },
  reqRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  reqRange: { fontSize: 12.5, fontWeight: '600', color: '#111111' },
  reqReason: { fontSize: 11, color: '#999999', marginTop: 1 },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 420 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 10 },
});
