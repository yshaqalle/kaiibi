import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { ProductForm } from '@/components/product-form';
import { deleteProduct } from '@/lib/products';
import type { NewProductInput, Product } from '@/types/models';

// Add/Edit product as an overlay instead of a routed page — so managing
// inventory doesn't lose your place in the list (search text, scroll
// position, sort) the way a full navigation away and back would.
export function ProductModal({
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
  initial?: Product;
  onSubmit: (input: NewProductInput) => Promise<void>;
  onDeleted?: () => void;
}) {
  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{initial ? 'Edit product' : 'Add product'}</Text>
            <Pressable onPress={onClose}><Text style={styles.close}>Done</Text></Pressable>
          </View>
          <View style={styles.formWrap}>
            <ProductForm
              initial={initial}
              shopId={shopId}
              submitLabel={initial ? 'Save changes' : 'Save product'}
              onSubmit={async (input) => { await onSubmit(input); onClose(); }}
            />
          </View>
          {initial && onDeleted && (
            <Pressable
              onPress={async () => { await deleteProduct(initial.id); onDeleted(); onClose(); }}
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
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, width: '100%', maxWidth: 560, maxHeight: '90%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { fontSize: 13, fontWeight: '700', color: '#999999' },
  formWrap: { flex: 1 },
  deleteButton: { alignItems: 'center', paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  deleteText: { color: '#C0392B', fontWeight: '800', fontSize: 13 },
});
