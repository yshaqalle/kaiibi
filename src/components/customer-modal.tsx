import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { CustomerForm, type CustomerFormHandle } from '@/components/customer-form';
import { StatTile } from '@/components/stat-tile';
import { formatCents } from '@/lib/currency';
import { deleteCustomer, getCustomerStats } from '@/lib/customers';
import type { Customer, NewCustomerInput } from '@/types/models';

type Stats = { totalSpentCents: number; visitCount: number; lastPurchaseAt: string | null };

// Add/Edit customer as an overlay instead of a routed page -- matches
// ProductModal, so managing customers doesn't lose your place in the list
// (search text, scroll position) the way a full navigation away and back
// would.
export function CustomerModal({
  visible,
  onClose,
  shopId,
  initial,
  onSubmit,
  onDeleted,
}: {
  visible: boolean;
  onClose: () => void;
  shopId: string;
  initial?: Customer;
  onSubmit: (input: NewCustomerInput) => Promise<void>;
  onDeleted?: () => void;
}) {
  const formRef = useRef<CustomerFormHandle>(null);
  const [status, setStatus] = useState({ valid: false, submitting: false });
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (visible && initial) {
      getCustomerStats(initial.id).then(setStats).catch(() => setStats(null));
    } else {
      setStats(null);
    }
  }, [visible, initial]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{initial ? 'Edit customer' : 'Add customer'}</Text>
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => formRef.current?.submit()}
                disabled={!status.valid || status.submitting}
                style={({ pressed }) => [styles.save, (!status.valid || status.submitting) && styles.saveDisabled, pressed && styles.savePressed]}
              >
                <Text style={styles.saveText}>{status.submitting ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.closePressed]}>
                <Text style={styles.closeText}>Done</Text>
              </Pressable>
            </View>
          </View>
          {stats && (
            <View style={styles.statsRow}>
              <StatTile value={formatCents(stats.totalSpentCents)} label="Total spent" />
              <StatTile value={String(stats.visitCount)} label="Visits" />
              <StatTile value={stats.lastPurchaseAt ? new Date(stats.lastPurchaseAt).toLocaleDateString() : '—'} label="Last purchase" />
            </View>
          )}
          <View style={styles.formWrap}>
            <CustomerForm
              ref={formRef}
              initial={initial}
              shopId={shopId}
              submitLabel={initial ? 'Save changes' : 'Save customer'}
              onSubmit={async (input) => { await onSubmit(input); onClose(); }}
              onStatusChange={setStatus}
            />
          </View>
          {initial && onDeleted && (
            <Pressable
              onPress={async () => { await deleteCustomer(initial.id); onDeleted(); onClose(); }}
              style={styles.deleteButton}
            >
              <Text style={styles.deleteText}>Delete customer</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, width: '100%', maxWidth: 560, height: '90%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  save: { backgroundColor: '#111111', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  saveDisabled: { backgroundColor: '#CCCCCC' },
  savePressed: { opacity: 0.7 },
  saveText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
  close: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  closePressed: { opacity: 0.6 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  statsRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 14 },
  formWrap: { flex: 1 },
  deleteButton: { alignItems: 'center', paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  deleteText: { color: '#C0392B', fontWeight: '800', fontSize: 13 },
});
