import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/badge';
import { decideTimeOffRequest } from '@/lib/time-off';
import type { StaffMember, TimeOffRequest } from '@/types/models';

export function TimeOffApprovalModal({
  visible,
  requests,
  staff,
  onClose,
  onChange,
}: {
  visible: boolean;
  requests: TimeOffRequest[];
  staff: StaffMember[];
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  if (!visible) return null;

  const nameFor = (shopMemberId: string) => staff.find((m) => m.id === shopMemberId)?.fullName ?? 'Staff member';

  const decide = async (id: string, decision: 'approved' | 'denied') => {
    setError(null);
    try {
      await decideTimeOffRequest(id, decision);
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Time off requests</Text>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          {error && <Text style={styles.error}>{error}</Text>}
          <ScrollView style={styles.list}>
            {requests.length === 0 ? (
              <Text style={styles.empty}>No time off requests yet.</Text>
            ) : (
              requests.map((r) => (
                <View key={r.id} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.range}>
                      {nameFor(r.shopMemberId)} · {r.startDate} – {r.endDate}
                    </Text>
                    {r.reason && <Text style={styles.reason}>{r.reason}</Text>}
                  </View>
                  {r.status === 'pending' ? (
                    <View style={styles.actions}>
                      <Pressable onPress={() => decide(r.id, 'approved')}>
                        <Text style={styles.approve}>Approve</Text>
                      </Pressable>
                      <Pressable onPress={() => decide(r.id, 'denied')}>
                        <Text style={styles.deny}>Deny</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Badge label={r.status === 'approved' ? 'Approved' : 'Denied'} tone={r.status === 'approved' ? 'success' : 'danger'} />
                  )}
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 480, height: '70%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  list: { flex: 1 },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 10 },
  empty: { color: '#999999', fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  range: { fontSize: 13, fontWeight: '600', color: '#111111' },
  reason: { fontSize: 11.5, color: '#999999', marginTop: 2 },
  actions: { flexDirection: 'row', gap: 12 },
  approve: { fontSize: 12.5, fontWeight: '700', color: '#2E7D46' },
  deny: { fontSize: 12.5, fontWeight: '700', color: '#B23B4E' },
});
