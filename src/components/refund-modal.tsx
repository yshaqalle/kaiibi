import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { QuantityStepper } from '@/components/quantity-stepper';
import { confirmDestructive } from '@/lib/confirm';
import { formatCents } from '@/lib/currency';
import { refundSaleItems } from '@/lib/sales';
import type { Sale } from '@/types/models';

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function refundedQtyFor(sale: Sale, saleItemId: string): number {
  return (sale.refunds ?? []).flatMap((r) => r.items).filter((i) => i.saleItemId === saleItemId).reduce((sum, i) => sum + i.quantity, 0);
}

// Lists a sale's current items with a QuantityStepper per line so a cashier
// can pick how much of each to refund in one go. Modeled on CustomerModal's
// centered-card shape rather than ReceiptModal's, since `sale` here is
// always already loaded (no async fetch on open).
export function RefundModal({
  visible,
  sale,
  onClose,
  onRefunded,
}: {
  visible: boolean;
  sale: Sale;
  onClose: () => void;
  onRefunded: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setSelected({});
      setError(null);
    }
  }, [visible, sale.id]);

  if (!visible) return null;

  const rows = (sale.items ?? [])
    .map((item) => ({ item, refunded: refundedQtyFor(sale, item.id), remaining: item.quantity - refundedQtyFor(sale, item.id) }))
    .filter((row) => row.remaining > 0);

  const previewCents = rows.reduce((sum, { item, refunded }) => {
    const qty = selected[item.id] ?? 0;
    if (qty === 0) return sum;
    const cum = Math.round((item.lineTotalCents * (refunded + qty)) / item.quantity);
    const prior = Math.round((item.lineTotalCents * refunded) / item.quantity);
    return sum + (cum - prior);
  }, 0);

  const canRefund = previewCents > 0 && !submitting;

  const confirmRefund = () => {
    confirmDestructive(
      'Refund these items?',
      `${formatCents(previewCents)} will be refunded and stock restored for the selected quantity.`,
      'Refund',
      async () => {
        setSubmitting(true);
        setError(null);
        try {
          const items = rows
            .filter(({ item }) => (selected[item.id] ?? 0) > 0)
            .map(({ item }) => ({ saleItemId: item.id, quantity: selected[item.id] }));
          await refundSaleItems(sale.id, items);
          await onRefunded();
        } catch (err) {
          setError(extractErrorMessage(err));
        } finally {
          setSubmitting(false);
        }
      }
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Refund items</Text>
            <Pressable onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.closePressed]}>
              <Text style={styles.closeText}>Done</Text>
            </Pressable>
          </View>

          <View style={styles.body}>
            {rows.length === 0 ? (
              <Text style={styles.empty}>Every item on this sale has already been refunded.</Text>
            ) : (
              rows.map(({ item, refunded, remaining }) => (
                <View key={item.id} style={styles.itemRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{item.productName}</Text>
                    <Text style={styles.itemMeta}>
                      {formatCents(item.unitPriceCents)} each · {remaining} of {item.quantity} refundable
                      {refunded > 0 ? ` · ${refunded} already refunded` : ''}
                    </Text>
                  </View>
                  <QuantityStepper
                    quantity={selected[item.id] ?? 0}
                    onChange={(next) => setSelected((current) => ({ ...current, [item.id]: Math.min(next, remaining) }))}
                  />
                </View>
              ))
            )}
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <View style={styles.footer}>
            <Text style={styles.totalLabel}>Refund total</Text>
            <Text style={styles.totalValue}>{formatCents(previewCents)}</Text>
          </View>
          <Pressable onPress={confirmRefund} disabled={!canRefund} style={[styles.refundButton, !canRefund && styles.refundButtonDisabled]}>
            <Text style={styles.refundButtonText}>{submitting ? 'Refunding…' : 'Refund selected items'}</Text>
          </Pressable>
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
  close: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  closePressed: { opacity: 0.6 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  body: { padding: 16 },
  empty: { color: '#999999', fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  itemRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 10, padding: 12, marginBottom: 8, gap: 10 },
  itemName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  itemMeta: { fontSize: 11, color: '#999999', marginTop: 3 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', paddingHorizontal: 20, marginBottom: 8 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 20, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  totalLabel: { color: '#111111', fontSize: 13, fontWeight: '800' },
  totalValue: { color: '#111111', fontSize: 20, fontWeight: '800' },
  refundButton: { backgroundColor: '#C0392B', margin: 20, marginTop: 12, paddingVertical: 13, borderRadius: 10, alignItems: 'center' },
  refundButtonDisabled: { backgroundColor: '#CCCCCC' },
  refundButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
});
