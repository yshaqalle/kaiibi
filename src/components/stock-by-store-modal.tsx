import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { QuantityStepper } from '@/components/quantity-stepper';
import { useAuth } from '@/hooks/use-auth';
import { setLocationStock } from '@/lib/products';
import type { Product } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';

// One product's stock, broken down by store, with a stepper per store.
//
// This exists because the combined inventory view has a genuinely ambiguous
// action: a single +/- next to a total of 40 across three stores has no correct
// answer for WHICH store it changes. The previous behaviour silently adjusted
// whichever store the device was set to, explained only by a line of hint text
// — quietly moving a count at a store the user isn't looking at.
//
// So in the combined view the stepper is replaced by this: the row stays one
// per product (the catalog is shop-wide), and the adjustment becomes explicit
// about where it lands. Scoped to a single store the inline stepper stays,
// because there the answer is unambiguous.
export function StockByStoreModal({
  product,
  onClose,
  onChanged,
  canEdit = true,
}: {
  product: Product;
  onClose: () => void;
  onChanged: () => Promise<void>;
  // Seeing WHERE stock sits is a read, so this opens for anyone who can view
  // inventory; only the steppers need `inventory.edit`. Without the split, a
  // read-only viewer would see "3 stores" with no way to find out which.
  canEdit?: boolean;
}) {
  const { locations } = useAuth();
  const stores = locations.filter((location) => location.active);

  // Seeded from what the list already fetched, then kept locally so each
  // stepper responds immediately rather than waiting on a round trip. Every
  // store is listed, including ones holding nothing — that is how you put stock
  // somewhere it has never been.
  const [counts, setCounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      stores.map((store) => [store.id, product.locationStock?.find((e) => e.locationId === store.id)?.stock ?? 0])
    )
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const adjust = async (locationId: string, next: number) => {
    const previous = counts[locationId] ?? 0;
    setCounts((current) => ({ ...current, [locationId]: next }));
    setSavingId(locationId);
    setError(null);
    try {
      await setLocationStock(product.id, locationId, next);
      await onChanged();
    } catch (err) {
      // Put the number back rather than leave the screen showing a count the
      // database refused — a stock figure that lies is worse than an error.
      setCounts((current) => ({ ...current, [locationId]: previous }));
      setError(extractErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title} numberOfLines={2}>{product.name}</Text>
              <Text style={styles.subtitle}>{total} in stock across {stores.length} stores</Text>
            </View>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Done</Text>
            </Pressable>
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <ScrollView style={styles.list}>
            {stores.map((store) => (
              <View key={store.id} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.storeName}>{store.name}</Text>
                  <Text style={styles.storeMeta}>
                    {savingId === store.id ? 'Saving…' : counts[store.id] === 0 ? 'None here' : `${counts[store.id]} here`}
                  </Text>
                </View>
                {canEdit ? (
                  <QuantityStepper
                    quantity={counts[store.id] ?? 0}
                    onChange={(next) => adjust(store.id, Math.max(0, next))}
                  />
                ) : (
                  <Text style={styles.readOnlyCount}>{counts[store.id] ?? 0}</Text>
                )}
              </View>
            ))}
          </ScrollView>

          {canEdit && (
            // "Stock → Move", not "Move stock": the header pill that name once
            // named is gone (Task 6 moved it behind the Stock door), and a
            // route named after a button that no longer exists is worse than
            // no route at all -- see the identical fix on inventory.tsx's
            // empty-store copy.
            <Text style={styles.footnote}>
              Each change saves to that store on its own. To move stock between stores instead, use Stock → Move.
            </Text>
          )}
        </View>
      </View>
    </AppModal>
  );
}

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Could not update this store’s stock.';
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 460, maxHeight: '80%' },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 },
  headerText: { flex: 1 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  subtitle: { fontSize: 12, color: '#9CA3AF', marginTop: 3 },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  list: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  rowText: { flex: 1 },
  storeName: { fontSize: 14, fontWeight: '700', color: '#111111' },
  storeMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  readOnlyCount: { fontSize: 14, fontWeight: '800', color: '#111111' },
  footnote: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginTop: 14 },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 10 },
});
