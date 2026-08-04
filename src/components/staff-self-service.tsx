import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { DateInput } from '@/components/date-input';
import { StatTile } from '@/components/stat-tile';
import { TIME_OFF_REASONS } from '@/constants/time-off';
import { formatAccountingCents } from '@/lib/currency';
import { toDateColumn } from '@/lib/period';
import { payRateUnitLabel } from '@/lib/pay-rate';
import { useAuth } from '@/hooks/use-auth';
import { clockIn, clockOut, getOpenTimeEntry, listMyTimeEntries, sumDurationHours } from '@/lib/time-entries';
import { cancelTimeOffRequest, listMyTimeOffRequests, requestTimeOff, updateTimeOffRequest } from '@/lib/time-off';
import { listMyShifts } from '@/lib/shifts';
import type { Shift } from '@/lib/scheduling';
import type { StaffMember, TimeEntry, TimeOffRequest } from '@/types/models';

// The self-service view is intentionally a component rather than a route so
// it can live under People → Team for every active staff member.
export function StaffSelfService({ shopId, member }: { shopId: string; member: StaffMember }) {
  const { activeLocation } = useAuth();
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [requests, setRequests] = useState<TimeOffRequest[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [editingRequest, setEditingRequest] = useState<TimeOffRequest | null>(null);
  const [canceling, setCanceling] = useState<string | null>(null);
  const [clocking, setClocking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const since = new Date();
    since.setDate(1);
    since.setHours(0, 0, 0, 0);
    try {
      const [open, myEntries, myRequests, myShifts] = await Promise.all([
        getOpenTimeEntry(member.id),
        listMyTimeEntries(member.id, since.toISOString()),
        listMyTimeOffRequests(member.id),
        listMyShifts(member.id, toDateColumn(new Date())),
      ]);
      setOpenEntry(open);
      setEntries(myEntries);
      setRequests(myRequests);
      setShifts(myShifts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }, [member.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!openEntry) return;
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, [openEntry]);

  const toggleClock = async () => {
    setClocking(true);
    setError(null);
    try {
      if (openEntry) await clockOut(openEntry.id);
      else {
        // Clocking in records WHERE, so a device with no store resolved must
        // refuse rather than guess -- a shift filed against the wrong store
        // quietly misstates that store's labour cost.
        if (!activeLocation) throw new Error('No store selected on this device. Pick one before clocking in.');
        await clockIn(shopId, member.id, activeLocation.id);
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update your clock status.');
    } finally {
      setClocking(false);
    }
  };

  const elapsedLabel = useMemo(() => {
    if (!openEntry) return null;
    const ms = now - new Date(openEntry.clockIn).getTime();
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m today`;
  }, [openEntry, now]);

  return (
    <View>
      <Card style={styles.clockCard}>
        <Text style={styles.clockStatus}>{openEntry ? `Clocked in since ${new Date(openEntry.clockIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not clocked in'}</Text>
        {elapsedLabel && <Text style={styles.clockElapsed}>{elapsedLabel}</Text>}
        <Pressable onPress={toggleClock} disabled={clocking} style={[styles.clockButton, clocking && styles.clockButtonDisabled]}>
          <Text style={styles.clockButtonText}>{clocking ? 'Working…' : openEntry ? 'Clock out' : 'Clock in'}</Text>
        </Pressable>
        {error && <Text style={styles.error}>{error}</Text>}
      </Card>

      <View style={styles.tiles}>
        <StatTile value={member.hireDate ? new Date(member.hireDate).toLocaleDateString() : '—'} label="Hire date" />
        <StatTile value={member.payType ? member.payType[0].toUpperCase() + member.payType.slice(1) : '—'} label="Pay type" />
        <StatTile
          value={member.payType && member.payRateCents !== null ? formatAccountingCents(member.payRateCents) : '—'}
          label={member.payType ? `Pay rate (${payRateUnitLabel(member.payType)})` : 'Pay rate'}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>RECENT SHIFTS</Text>
        {entries.length === 0 ? <Text style={styles.empty}>No shifts logged this period.</Text> : entries.slice(0, 8).map((entry) => (
          <View key={entry.id} style={styles.row}>
            <Text style={styles.rowText}>{new Date(entry.clockIn).toLocaleDateString()} · {new Date(entry.clockIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{entry.clockOut ? `–${new Date(entry.clockOut).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' (on shift)'}</Text>
            <Text style={styles.duration}>{entry.clockOut ? `${sumDurationHours([entry]).toFixed(1)}h` : '—'}</Text>
          </View>
        ))}
        <Text style={styles.periodTotal}>{sumDurationHours(entries).toFixed(1)}h logged this period</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>MY UPCOMING SHIFTS</Text>
        {shifts.length === 0 ? (
          <Text style={styles.empty}>Nothing scheduled yet.</Text>
        ) : (
          shifts.slice(0, 10).map((shift) => (
            <View key={shift.id} style={styles.row}>
              <Text style={styles.rowText}>
                {shift.date}
                {shift.note ? ` · ${shift.note}` : ''}
              </Text>
              <Text style={styles.duration}>{shift.start}–{shift.end}</Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>TIME OFF</Text>
          <Pressable onPress={() => setShowRequestModal(true)} style={styles.requestButton}>
            <Text style={styles.requestButtonText}>Request time off</Text>
          </Pressable>
        </View>
        {requests.length === 0 ? <Text style={styles.empty}>No requests yet.</Text> : requests.map((request) => (
          <View key={request.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowText}>{request.startDate} – {request.endDate}</Text>
              {request.reason && <Text style={styles.reason}>{request.reason}</Text>}
            </View>
            <Badge label={request.status === 'pending' ? 'Pending' : request.status === 'approved' ? 'Approved' : 'Denied'} tone={request.status === 'pending' ? 'warning' : request.status === 'approved' ? 'success' : 'danger'} />
            <View style={styles.requestActions}>
              {request.status === 'pending' && (
                <Pressable onPress={() => setEditingRequest(request)} style={styles.actionButton}>
                  <Text style={styles.actionText}>Edit</Text>
                </Pressable>
              )}
              <Pressable
                onPress={async () => {
                  setCanceling(request.id);
                  try {
                    await cancelTimeOffRequest(request.id);
                    await reload();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Could not cancel this request.');
                    setCanceling(null);
                  }
                }}
                disabled={canceling === request.id}
                style={[styles.actionButton, styles.cancelButton]}
              >
                <Text style={[styles.actionText, styles.cancelText]}>{canceling === request.id ? 'Canceling…' : 'Cancel'}</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>

      <RequestTimeOffModal
        visible={showRequestModal && !editingRequest}
        onClose={() => setShowRequestModal(false)}
        onSubmit={async (input) => {
          await requestTimeOff(shopId, member.id, input);
          await reload();
          setShowRequestModal(false);
        }}
      />

      {editingRequest && (
        <EditTimeOffModal
          visible={true}
          request={editingRequest}
          onClose={() => setEditingRequest(null)}
          onSubmit={async (input) => {
            await updateTimeOffRequest(editingRequest.id, input);
            await reload();
            setEditingRequest(null);
          }}
        />
      )}
    </View>
  );
}

function RequestTimeOffModal({ visible, onClose, onSubmit }: { visible: boolean; onClose: () => void; onSubmit: (input: { dateRanges: {startDate: string; endDate: string}[]; reason?: string | null }) => Promise<void> }) {
  const [dateRanges, setDateRanges] = useState<{startDate: string; endDate: string}[]>([]);
  const [tempStartDate, setTempStartDate] = useState('');
  const [tempEndDate, setTempEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [reasonDropdownOpen, setReasonDropdownOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setDateRanges([]);
    setTempStartDate('');
    setTempEndDate('');
    setReason('');
    setReasonDropdownOpen(false);
    setError(null);
  }, [visible]);

  const addRange = () => {
    if (!tempStartDate.trim() || !tempEndDate.trim()) return;
    // Check for overlaps
    const newRange = { startDate: tempStartDate, endDate: tempEndDate };
    for (const range of dateRanges) {
      const r1Start = new Date(range.startDate);
      const r1End = new Date(range.endDate);
      const r2Start = new Date(newRange.startDate);
      const r2End = new Date(newRange.endDate);
      if (r1Start <= r2End && r2Start <= r1End) {
        setError(`Overlaps with existing range: ${range.startDate} to ${range.endDate}`);
        return;
      }
    }
    setDateRanges([...dateRanges, newRange].sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()));
    setTempStartDate('');
    setTempEndDate('');
    setError(null);
  };

  const removeRange = (index: number) => {
    setDateRanges(dateRanges.filter((_, i) => i !== index));
  };

  const submit = async () => {
    if (dateRanges.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ dateRanges, reason: reason.trim() || null });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit this request.');
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}><View style={styles.overlay}><View style={styles.modalCard}>
    <Text style={styles.modalTitle}>Request time off</Text>
    <Text style={styles.modalSubtitle}>Add one or more date ranges (e.g., work Mon/Wed, off Tue/Thu)</Text>
    
    <View style={styles.dateField}><Text style={styles.fieldLabel}>Start date</Text><DateInput value={tempStartDate} onChangeText={(nextStartDate) => { setTempStartDate(nextStartDate); if (tempEndDate && tempEndDate < nextStartDate) setTempEndDate(nextStartDate); }} /></View>
    <View style={styles.dateField}><Text style={styles.fieldLabel}>End date</Text><DateInput value={tempEndDate} onChangeText={setTempEndDate} minimumDate={tempStartDate || undefined} /></View>
    
    <Pressable onPress={addRange} disabled={!tempStartDate.trim() || !tempEndDate.trim()} style={[styles.addRangeButton, (!tempStartDate.trim() || !tempEndDate.trim()) && styles.addRangeButtonDisabled]}><Text style={styles.addRangeText}>+ Add date range</Text></Pressable>

    {dateRanges.length > 0 && (
      <View style={styles.selectedRanges}>
        <Text style={styles.selectedRangesTitle}>Selected ranges:</Text>
        {dateRanges.map((range, idx) => (
          <View key={idx} style={styles.selectedRangeItem}>
            <Text style={styles.selectedRangeText}>{range.startDate} to {range.endDate}</Text>
            <Pressable onPress={() => removeRange(idx)} style={styles.removeRangeButton}><Text style={styles.removeRangeText}>✕</Text></Pressable>
          </View>
        ))}
      </View>
    )}

    <View style={styles.reasonField}>
      <Text style={styles.fieldLabel}>Reason (optional)</Text>
      <Pressable onPress={() => setReasonDropdownOpen(!reasonDropdownOpen)} style={styles.reasonButton}>
        <Text style={[styles.reasonButtonText, !reason && styles.reasonButtonPlaceholder]}>{reason || 'Select or enter reason'}</Text>
        <Text style={styles.reasonDropdownIcon}>{reasonDropdownOpen ? '▼' : '▶'}</Text>
      </Pressable>
      {reasonDropdownOpen && (
        <ScrollView style={styles.reasonDropdown} scrollEnabled={true} nestedScrollEnabled={true}>
          {TIME_OFF_REASONS.map((item) => (
            <Pressable key={item} onPress={() => { setReason(item); setReasonDropdownOpen(false); }} style={styles.reasonOption}>
              <Text style={styles.reasonOptionText}>{item}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <TextInput value={reason} onChangeText={setReason} placeholder="Or type custom reason" style={[styles.input, styles.reasonInput]} />
    </View>
    {error && <Text style={styles.error}>{error}</Text>}
    <View style={styles.modalActions}><Pressable onPress={onClose} style={styles.secondaryButton}><Text style={styles.secondaryText}>Cancel</Text></Pressable><Pressable onPress={submit} disabled={saving || dateRanges.length === 0} style={[styles.primaryButton, (saving || dateRanges.length === 0) && styles.clockButtonDisabled]}><Text style={styles.primaryText}>{saving ? 'Sending…' : 'Send request'}</Text></Pressable></View>
  </View></View></Modal>;
}

function EditTimeOffModal({ visible, request, onClose, onSubmit }: { visible: boolean; request: TimeOffRequest; onClose: () => void; onSubmit: (input: { dateRanges: {startDate: string; endDate: string}[]; reason?: string | null }) => Promise<void> }) {
  const [dateRanges, setDateRanges] = useState<{startDate: string; endDate: string}[]>(request.dateRanges || []);
  const [tempStartDate, setTempStartDate] = useState('');
  const [tempEndDate, setTempEndDate] = useState('');
  const [reason, setReason] = useState(request.reason ?? '');
  const [reasonDropdownOpen, setReasonDropdownOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDateRanges(request.dateRanges || []);
    setTempStartDate('');
    setTempEndDate('');
    setReason(request.reason ?? '');
    setReasonDropdownOpen(false);
    setError(null);
  }, [request]);

  const addRange = () => {
    if (!tempStartDate.trim() || !tempEndDate.trim()) return;
    // Check for overlaps
    const newRange = { startDate: tempStartDate, endDate: tempEndDate };
    for (const range of dateRanges) {
      const r1Start = new Date(range.startDate);
      const r1End = new Date(range.endDate);
      const r2Start = new Date(newRange.startDate);
      const r2End = new Date(newRange.endDate);
      if (r1Start <= r2End && r2Start <= r1End) {
        setError(`Overlaps with existing range: ${range.startDate} to ${range.endDate}`);
        return;
      }
    }
    setDateRanges([...dateRanges, newRange].sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()));
    setTempStartDate('');
    setTempEndDate('');
    setError(null);
  };

  const removeRange = (index: number) => {
    setDateRanges(dateRanges.filter((_, i) => i !== index));
  };

  const submit = async () => {
    if (dateRanges.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ dateRanges, reason: reason.trim() || null });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this request.');
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}><View style={styles.overlay}><View style={styles.modalCard}>
    <Text style={styles.modalTitle}>Edit time off request</Text>
    <Text style={styles.modalSubtitle}>Add or remove date ranges</Text>
    
    <View style={styles.dateField}><Text style={styles.fieldLabel}>Start date</Text><DateInput value={tempStartDate} onChangeText={(nextStartDate) => { setTempStartDate(nextStartDate); if (tempEndDate && tempEndDate < nextStartDate) setTempEndDate(nextStartDate); }} /></View>
    <View style={styles.dateField}><Text style={styles.fieldLabel}>End date</Text><DateInput value={tempEndDate} onChangeText={setTempEndDate} minimumDate={tempStartDate || undefined} /></View>
    
    <Pressable onPress={addRange} disabled={!tempStartDate.trim() || !tempEndDate.trim()} style={[styles.addRangeButton, (!tempStartDate.trim() || !tempEndDate.trim()) && styles.addRangeButtonDisabled]}><Text style={styles.addRangeText}>+ Add date range</Text></Pressable>

    {dateRanges.length > 0 && (
      <View style={styles.selectedRanges}>
        <Text style={styles.selectedRangesTitle}>Selected ranges:</Text>
        {dateRanges.map((range, idx) => (
          <View key={idx} style={styles.selectedRangeItem}>
            <Text style={styles.selectedRangeText}>{range.startDate} to {range.endDate}</Text>
            <Pressable onPress={() => removeRange(idx)} style={styles.removeRangeButton}><Text style={styles.removeRangeText}>✕</Text></Pressable>
          </View>
        ))}
      </View>
    )}

    <View style={styles.reasonField}>
      <Text style={styles.fieldLabel}>Reason (optional)</Text>
      <Pressable onPress={() => setReasonDropdownOpen(!reasonDropdownOpen)} style={styles.reasonButton}>
        <Text style={[styles.reasonButtonText, !reason && styles.reasonButtonPlaceholder]}>{reason || 'Select or enter reason'}</Text>
        <Text style={styles.reasonDropdownIcon}>{reasonDropdownOpen ? '▼' : '▶'}</Text>
      </Pressable>
      {reasonDropdownOpen && (
        <ScrollView style={styles.reasonDropdown} scrollEnabled={true} nestedScrollEnabled={true}>
          {TIME_OFF_REASONS.map((item) => (
            <Pressable key={item} onPress={() => { setReason(item); setReasonDropdownOpen(false); }} style={styles.reasonOption}>
              <Text style={styles.reasonOptionText}>{item}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <TextInput value={reason} onChangeText={setReason} placeholder="Or type custom reason" style={[styles.input, styles.reasonInput]} />
    </View>
    {error && <Text style={styles.error}>{error}</Text>}
    <View style={styles.modalActions}><Pressable onPress={onClose} style={styles.secondaryButton}><Text style={styles.secondaryText}>Cancel</Text></Pressable><Pressable onPress={submit} disabled={saving || dateRanges.length === 0} style={[styles.primaryButton, (saving || dateRanges.length === 0) && styles.clockButtonDisabled]}><Text style={styles.primaryText}>{saving ? 'Saving…' : 'Save changes'}</Text></Pressable></View>
  </View></View></Modal>;
}

const styles = StyleSheet.create({
  clockCard: { padding: 18, marginBottom: 14 }, clockStatus: { color: '#111111', fontSize: 16, fontWeight: '800' }, clockElapsed: { color: '#777777', fontSize: 12, marginTop: 3 }, clockButton: { alignSelf: 'flex-start', marginTop: 14, backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 }, clockButtonDisabled: { opacity: 0.5 }, clockButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 }, error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 10 },
  tiles: { flexDirection: 'row', gap: 9, marginBottom: 16 }, section: { marginBottom: 18 }, sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }, sectionTitle: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, color: '#999999' }, requestButton: { backgroundColor: '#111111', borderRadius: 8, paddingHorizontal: 11, paddingVertical: 8 }, requestButtonText: { color: '#FFFFFF', fontSize: 11.5, fontWeight: '800' }, empty: { color: '#999999', fontSize: 13, paddingVertical: 8 }, row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#ECECEC' }, rowText: { color: '#666666', fontSize: 12, flexShrink: 1 }, duration: { color: '#111111', fontSize: 12, fontWeight: '700' }, reason: { color: '#999999', fontSize: 11, marginTop: 2 }, periodTotal: { color: '#666666', fontSize: 12, fontWeight: '700', marginTop: 10 }, requestActions: { flexDirection: 'row', gap: 6, alignItems: 'center' }, actionButton: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, backgroundColor: '#F2F2F2' }, cancelButton: { backgroundColor: '#F7E1E2' }, actionText: { fontSize: 11, fontWeight: '700', color: '#111111' }, cancelText: { color: '#B23B4E' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 20 }, modalCard: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 20, maxWidth: 480, width: '100%', alignSelf: 'center', maxHeight: '90%' }, modalTitle: { color: '#111111', fontSize: 17, fontWeight: '800', marginBottom: 4 }, modalSubtitle: { color: '#999999', fontSize: 12, marginBottom: 14 }, dateField: { marginBottom: 10 }, fieldLabel: { color: '#666666', fontSize: 11.5, fontWeight: '700', marginBottom: 5 }, input: { borderWidth: 1, borderColor: '#E2E2E2', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: '#111111', marginBottom: 10 }, reasonInput: { minHeight: 82, textAlignVertical: 'top' }, reasonField: { marginBottom: 12 }, reasonButton: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: '#E2E2E2', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#FFFFFF', marginBottom: 8 }, reasonButtonText: { color: '#111111', fontSize: 13, fontWeight: '600' }, reasonButtonPlaceholder: { color: '#999999' }, reasonDropdownIcon: { color: '#999999', fontSize: 11 }, reasonDropdown: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E2E2', borderRadius: 8, borderTopWidth: 0, marginBottom: 8, maxHeight: 200, overflow: 'hidden' }, reasonOption: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' }, reasonOptionText: { color: '#111111', fontSize: 12 }, addRangeButton: { backgroundColor: '#F2F2F2', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12, alignItems: 'center' }, addRangeButtonDisabled: { opacity: 0.5 }, addRangeText: { color: '#111111', fontSize: 12, fontWeight: '700' }, selectedRanges: { backgroundColor: '#F9F9F9', borderRadius: 8, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: '#ECECEC' }, selectedRangesTitle: { color: '#666666', fontSize: 11, fontWeight: '700', marginBottom: 8 }, selectedRangeItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 6, borderWidth: 1, borderColor: '#E2E2E2' }, selectedRangeText: { color: '#111111', fontSize: 12, fontWeight: '600' }, removeRangeButton: { padding: 4 }, removeRangeText: { color: '#999999', fontSize: 14, fontWeight: '700' }, modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 }, secondaryButton: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 }, secondaryText: { color: '#111111', fontSize: 12, fontWeight: '800' }, primaryButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 }, primaryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
});
