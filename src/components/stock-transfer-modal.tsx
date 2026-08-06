import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { QuantityStepper } from '@/components/quantity-stepper';
import { useAuth } from '@/hooks/use-auth';
import { describePlanError } from '@/lib/entitlements';
import { listProducts, transferStock } from '@/lib/products';
import type { Product } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';

// Moving stock between stores.
//
// Without this, per-store stock is a dead end operationally: a shop that
// receives a delivery centrally has no way to distribute it, and would resort
// to editing both counts by hand -- two writes that can half-fail, leaving the
// business short with no record of what moved.
//
// Everything goes through the transfer_stock RPC, which moves both sides in one
// transaction and writes a stock_transfers record. This screen never adjusts a
// count directly.

type Line = { product: Product; quantity: number };

export function StockTransferModal({
  visible,
  shopId,
  onClose,
  onDone,
}: {
  visible: boolean;
  shopId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { locations, activeLocation } = useAuth();
  const selectable = useMemo(() => locations.filter((location) => location.active), [locations]);

  const [fromId, setFromIdState] = useState<string | null>(activeLocation?.id ?? null);
  const [toId, setToId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [sourceStock, setSourceStock] = useState<Product[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Products are refetched scoped to the SOURCE store, so the counts shown are
  // what is actually available to move -- not the shop-wide rollup, which would
  // offer stock sitting at a third store.
  useEffect(() => {
    if (!visible || !fromId) return;
    let active = true;
    listProducts(shopId, fromId)
      .then((rows) => {
        if (active) setSourceStock(rows);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [visible, shopId, fromId]);

  // Changing the source clears the basket: the quantities were chosen against
  // the old store's availability and mean nothing against the new one's. Done
  // in the handler rather than an effect on `fromId` — an effect would be a
  // cascading render, and this is simply part of what "change the source"
  // means.
  const setFromId = (locationId: string) => {
    setFromIdState(locationId);
    setLines([]);
    if (toId === locationId) setToId(null);
  };

  if (!visible) return null;

  const availableOf = (productId: string) => sourceStock.find((p) => p.id === productId)?.stock ?? 0;

  const matches = search.trim()
    ? sourceStock.filter(
        (p) =>
          p.stock > 0 &&
          !lines.some((line) => line.product.id === p.id) &&
          (p.name.toLowerCase().includes(search.trim().toLowerCase()) ||
            (p.sku ?? '').toLowerCase().includes(search.trim().toLowerCase()))
      )
    : [];

  const overCommitted = lines.some((line) => line.quantity > availableOf(line.product.id));
  const canSubmit =
    Boolean(fromId) && Boolean(toId) && fromId !== toId && lines.length > 0 && !overCommitted && !busy;

  const submit = async () => {
    if (!canSubmit || !fromId || !toId) return;
    setBusy(true);
    setError(null);
    try {
      await transferStock(
        shopId,
        fromId,
        toId,
        lines.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
        note.trim() || null
      );
      await onDone();
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Move stock</Text>
            <View style={styles.headerActions}>
              <Pressable onPress={submit} disabled={!canSubmit} style={[styles.primary, !canSubmit && styles.disabled]}>
                <Text style={styles.primaryText}>{busy ? 'Moving…' : 'Move stock'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView style={styles.body}>
            <Text style={styles.label}>FROM</Text>
            <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
              {selectable.map((location) => (
                <CategoryChip key={location.id} label={location.name} active={fromId === location.id} onPress={() => setFromId(location.id)} />
              ))}
            </ScrollView>

            <Text style={[styles.label, styles.labelSpaced]}>TO</Text>
            <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
              {/* The source is excluded rather than shown-and-rejected: a
                  transfer to itself moves nothing, and the RPC refuses it. */}
              {selectable
                .filter((location) => location.id !== fromId)
                .map((location) => (
                  <CategoryChip key={location.id} label={location.name} active={toId === location.id} onPress={() => setToId(location.id)} />
                ))}
            </ScrollView>

            <Text style={[styles.label, styles.labelSpaced]}>ITEMS</Text>
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search a product to add"
              placeholderTextColor="#999999"
              style={styles.input}
            />
            {matches.slice(0, 6).map((product) => (
              <Pressable
                key={product.id}
                onPress={() => {
                  setLines((current) => [...current, { product, quantity: 1 }]);
                  setSearch('');
                }}
                style={styles.suggestion}
              >
                <Text style={styles.suggestionName}>{product.name}</Text>
                <Text style={styles.suggestionMeta}>{product.stock} here</Text>
              </Pressable>
            ))}

            {lines.length === 0 ? (
              <Text style={styles.empty}>No items yet — search above to add what you&apos;re moving.</Text>
            ) : (
              lines.map((line) => {
                const available = availableOf(line.product.id);
                const tooMany = line.quantity > available;
                return (
                  <View key={line.product.id} style={styles.lineRow}>
                    <View style={styles.lineText}>
                      <Text style={styles.lineName}>{line.product.name}</Text>
                      <Text style={[styles.lineMeta, tooMany && styles.lineMetaBad]}>
                        {tooMany ? `Only ${available} at this store` : `${available} available`}
                      </Text>
                    </View>
                    <QuantityStepper
                      quantity={line.quantity}
                      onChange={(quantity) =>
                        setLines((current) =>
                          quantity === 0
                            ? current.filter((l) => l.product.id !== line.product.id)
                            : current.map((l) => (l.product.id === line.product.id ? { ...l, quantity } : l))
                        )
                      }
                    />
                  </View>
                );
              })
            )}

            <Text style={[styles.label, styles.labelSpaced]}>NOTE</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Why this is moving, if it helps"
              placeholderTextColor="#999999"
              style={styles.input}
            />

            {error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

// Supabase/PostgREST errors are plain {code, message, ...} objects, never
// `instanceof Error`. The RPC's own message is the useful one here — it names
// the product and the counts ("insufficient stock for Soap at the source
// location: has 4, need 10").
function extractErrorMessage(err: unknown): string {
  // Moving stock between branches is the multi_location module, so this is the
  // most likely place a Standard shop meets a plan wall. Without this it would
  // read as the bare string "module_not_included".
  const planError = describePlanError(err);
  if (planError) return planError;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Could not move this stock.';
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: '85%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  body: { flexGrow: 0 },
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginBottom: 6 },
  labelSpaced: { marginTop: 16 },
  chips: { flexDirection: 'row', gap: 6, paddingRight: 8 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  suggestion: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  suggestionName: { fontSize: 13, fontWeight: '600', color: '#111111' },
  suggestionMeta: { fontSize: 12, color: '#9CA3AF' },
  empty: { fontSize: 13, color: '#9CA3AF', marginTop: 12 },
  lineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 10 },
  lineText: { flex: 1 },
  lineName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  lineMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  lineMetaBad: { color: '#C0392B', fontWeight: '700' },
  primary: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  primaryText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  disabled: { backgroundColor: '#CCCCCC' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 12 },
});
