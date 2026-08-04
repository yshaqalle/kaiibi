import { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { ProductForm, type ProductFormHandle } from '@/components/product-form';
import { confirmDestructive } from '@/lib/confirm';
import { deleteProduct } from '@/lib/products';
import type { NewProductInput, Product } from '@/types/models';

// Add/Edit product as an overlay instead of a routed page — so managing
// inventory doesn't lose your place in the list (search text, scroll
// position, sort) the way a full navigation away and back would.
export function ProductModal({
  visible,
  onClose,
  shopId,
  defaultLocationId,
  initial,
  onSubmit,
  onDeleted,
}: {
  visible: boolean;
  onClose: () => void;
  shopId: string;
  defaultLocationId?: string | null;
  initial?: Product;
  onSubmit: (input: NewProductInput, locationId: string | null) => Promise<void>;
  onDeleted?: () => void;
}) {
  const formRef = useRef<ProductFormHandle>(null);
  const [status, setStatus] = useState({ valid: false, submitting: false });

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{initial ? 'Edit product' : 'Add product'}</Text>
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
          <View style={styles.formWrap}>
            <ProductForm
              ref={formRef}
              initial={initial}
              shopId={shopId}
              defaultLocationId={defaultLocationId}
              submitLabel={initial ? 'Save changes' : 'Save product'}
              onSubmit={async (input, locationId) => { await onSubmit(input, locationId); onClose(); }}
              onStatusChange={setStatus}
            />
          </View>
          {initial && onDeleted && (
            <Pressable
              onPress={() =>
                confirmDestructive('Delete product?', 'This removes it from inventory. Past sales are not affected.', 'Delete product', async () => {
                  await deleteProduct(initial.id);
                  onDeleted();
                  onClose();
                })
              }
              style={styles.deleteButton}
            >
              <Text style={styles.deleteText}>Delete product</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  // `height` (not `maxHeight`) — `formWrap` below is `flex: 1` and needs a
  // concrete parent size to fill; against a `maxHeight`-only, content-sized
  // parent it resolves to zero height instead, collapsing the whole form
  // (the same Yoga flex-basis pitfall as the POS split panes; see pos.tsx).
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
  formWrap: { flex: 1 },
  deleteButton: { alignItems: 'center', paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  deleteText: { color: '#C0392B', fontWeight: '800', fontSize: 13 },
});
