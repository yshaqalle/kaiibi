import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { PaymentMethodPicker } from '@/components/payment-method-picker';
import { QuantityStepper } from '@/components/quantity-stepper';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { listProducts } from '@/lib/products';
import { deleteSale, editSale, listSalesInRange } from '@/lib/sales';
import type { PaymentLine, Product, Sale, SaleItemSnapshot } from '@/types/models';

const paymentLabels: Record<Sale['paymentMethod'], string> = { cash: 'Cash', zaad: 'ZAAD', edahab: 'e-Dahab', other: 'Other' };
const rangePresets = [7, 14, 30, 90] as const;

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const date = new Date(`${value.trim()}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export default function SalesScreen() {
  const { shop } = useAuth();
  const [sales, setSales] = useState<Sale[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [daysBack, setDaysBack] = useState<number>(14);
  const [rangeMode, setRangeMode] = useState<'preset' | 'custom'>('preset');
  const [customStartInput, setCustomStartInput] = useState('');
  const [customEndInput, setCustomEndInput] = useState('');
  const [appliedCustomRange, setAppliedCustomRange] = useState<{ start: string; end: string } | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sinceDate = useMemo(() => {
    if (rangeMode === 'custom' && appliedCustomRange) {
      return parseDateInput(appliedCustomRange.start) ?? new Date(0);
    }
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [rangeMode, daysBack, appliedCustomRange]);

  const untilDate = useMemo(() => {
    if (rangeMode !== 'custom' || !appliedCustomRange) return undefined;
    const end = parseDateInput(appliedCustomRange.end);
    if (!end) return undefined;
    end.setHours(23, 59, 59, 999);
    return end;
  }, [rangeMode, appliedCustomRange]);

  const customRangeValid = useMemo(() => {
    const start = parseDateInput(customStartInput);
    const end = parseDateInput(customEndInput);
    return Boolean(start && end && start <= end);
  }, [customStartInput, customEndInput]);

  const applyCustomRange = () => {
    if (!customRangeValid) return;
    setAppliedCustomRange({ start: customStartInput, end: customEndInput });
  };

  const selectPreset = (days: number) => {
    setRangeMode('preset');
    setDaysBack(days);
  };

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      const [salesRows, productRows] = await Promise.all([listSalesInRange(shop.id, sinceDate, untilDate), listProducts(shop.id)]);
      setSales(salesRows);
      setProducts(productRows);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop, sinceDate, untilDate]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sales;
    return sales.filter((sale) =>
      (sale.items ?? []).some((item) => item.productName.toLowerCase().includes(q)) ||
      (sale.payments ?? []).some((p) => (p.customerName ?? '').toLowerCase().includes(q) || (p.customerPhone ?? '').toLowerCase().includes(q)) ||
      paymentLabels[sale.paymentMethod].toLowerCase().includes(q)
    );
  }, [sales, search]);

  const rangeTotalCents = filtered.reduce((sum, s) => sum + s.totalCents, 0);
  const rangeLabel = rangeMode === 'custom' && appliedCustomRange ? `${appliedCustomRange.start} – ${appliedCustomRange.end}` : `Last ${daysBack} days`;

  const handleDelete = async (saleId: string) => {
    setError(null);
    try {
      await deleteSale(saleId);
      setConfirmDeleteId(null);
      setExpandedId(null);
      await reload();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Sales</Text>
        <View style={styles.metricRow}>
          <StatTile value={formatCents(rangeTotalCents)} label={rangeLabel} />
          <StatTile value={String(filtered.length)} label="Orders" />
        </View>

        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search by product, customer, or payment method"
          placeholderTextColor="#999999"
          style={styles.search}
        />

        <View style={styles.rangeRow}>
          {rangePresets.map((days) => (
            <Pressable key={days} onPress={() => selectPreset(days)} style={[styles.rangeChip, rangeMode === 'preset' && daysBack === days && styles.rangeChipActive]}>
              <Text style={[styles.rangeChipText, rangeMode === 'preset' && daysBack === days && styles.rangeChipTextActive]}>{days}d</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setRangeMode('custom')} style={[styles.rangeChip, rangeMode === 'custom' && styles.rangeChipActive]}>
            <Text style={[styles.rangeChipText, rangeMode === 'custom' && styles.rangeChipTextActive]}>Custom range</Text>
          </Pressable>
        </View>

        {rangeMode === 'custom' && (
          <View style={styles.customRangeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>FROM</Text>
              <TextInput value={customStartInput} onChangeText={setCustomStartInput} placeholder="YYYY-MM-DD" placeholderTextColor="#999999" style={styles.dateInput} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>TO</Text>
              <TextInput value={customEndInput} onChangeText={setCustomEndInput} placeholder="YYYY-MM-DD" placeholderTextColor="#999999" style={styles.dateInput} />
            </View>
            <Pressable onPress={applyCustomRange} disabled={!customRangeValid} style={[styles.applyButton, !customRangeValid && styles.applyButtonDisabled]}>
              <Text style={styles.applyButtonText}>Apply</Text>
            </Pressable>
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>{search ? 'No sales match your search.' : rangeMode === 'custom' ? 'No sales in this range.' : `No sales in the last ${daysBack} days.`}</Text>
        ) : (
          <View style={styles.list}>
            {filtered.map((sale) => (
              <SaleRow
                key={sale.id}
                sale={sale}
                products={products}
                expanded={expandedId === sale.id}
                editing={editingId === sale.id}
                confirmingDelete={confirmDeleteId === sale.id}
                onToggle={() => setExpandedId((current) => (current === sale.id ? null : sale.id))}
                onStartEdit={() => { setEditingId(sale.id); setExpandedId(sale.id); }}
                onCancelEdit={() => setEditingId(null)}
                onSaved={async () => { setEditingId(null); await reload(); }}
                onConfirmDelete={() => setConfirmDeleteId(sale.id)}
                onCancelDelete={() => setConfirmDeleteId(null)}
                onDelete={() => handleDelete(sale.id)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SaleRow({
  sale,
  products,
  expanded,
  editing,
  confirmingDelete,
  onToggle,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
}: {
  sale: Sale;
  products: Product[];
  expanded: boolean;
  editing: boolean;
  confirmingDelete: boolean;
  onToggle: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const editCount = sale.edits?.length ?? 0;

  return (
    <View style={styles.card}>
      <Pressable onPress={onToggle} style={styles.saleRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.saleItems} numberOfLines={1}>{sale.items?.map((item) => `${item.quantity}× ${item.productName}`).join(', ')}</Text>
          <Text style={styles.saleMeta}>
            {new Date(sale.createdAt).toLocaleString()} · {paymentLabels[sale.paymentMethod]}
            {editCount > 0 ? ` · Edited ${editCount}×` : ''}
          </Text>
        </View>
        <Text style={styles.saleTotal}>{formatCents(sale.totalCents)}</Text>
      </Pressable>

      {expanded && !editing && (
        <View style={styles.detail}>
          <Text style={styles.detailLabel}>ITEMS</Text>
          {sale.items?.map((item) => (
            <View key={item.id} style={styles.detailRow}>
              <Text style={styles.detailItemName}>{item.quantity}× {item.productName}</Text>
              <Text style={styles.detailItemPrice}>{formatCents(item.lineTotalCents)}</Text>
            </View>
          ))}

          <Text style={[styles.detailLabel, { marginTop: 14 }]}>PAYMENT</Text>
          {sale.payments?.map((payment) => (
            <View key={payment.id} style={styles.detailRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.detailItemName}>{paymentLabels[payment.method]}{payment.customerName ? ` · ${payment.customerName}` : ''}</Text>
                {payment.customerPhone && <Text style={styles.saleMeta}>{payment.customerPhone}</Text>}
                {payment.tenderedCents !== null && (
                  <Text style={styles.saleMeta}>Tendered {formatCents(payment.tenderedCents)} · Change {formatCents(payment.tenderedCents - payment.amountCents)}</Text>
                )}
              </View>
              <Text style={styles.detailItemPrice}>{formatCents(payment.amountCents)}</Text>
            </View>
          ))}

          {editCount > 0 && (
            <>
              <Pressable onPress={() => setHistoryOpen((v) => !v)} style={{ marginTop: 14 }}>
                <Text style={styles.historyToggle}>{historyOpen ? '▴' : '▾'} Edit history ({editCount})</Text>
              </Pressable>
              {historyOpen && (
                <View style={styles.historyList}>
                  {sale.edits?.map((edit) => (
                    <View key={edit.id} style={styles.historyEntry}>
                      <Text style={styles.historyDate}>Previous version — {new Date(edit.createdAt).toLocaleString()}</Text>
                      {edit.previousSnapshot.items.map((item: SaleItemSnapshot, index: number) => (
                        <Text key={index} style={styles.historyItem}>{item.quantity}× {item.productName} — {formatCents(item.lineTotalCents)}</Text>
                      ))}
                      <Text style={styles.historyTotal}>Total: {formatCents(edit.previousSnapshot.totalCents)} · {paymentLabels[edit.previousSnapshot.paymentMethod]}</Text>
                    </View>
                  ))}
                </View>
              )}
            </>
          )}

          {confirmingDelete ? (
            <View style={styles.confirmRow}>
              <Text style={styles.confirmText}>Delete this sale? Stock will be restored.</Text>
              <Pressable onPress={onDelete}><Text style={styles.confirmDanger}>Confirm</Text></Pressable>
              <Pressable onPress={onCancelDelete}><Text style={styles.confirmCancel}>Cancel</Text></Pressable>
            </View>
          ) : (
            <View style={styles.actionRow}>
              <Pressable onPress={onStartEdit} style={styles.actionButton}><Text style={styles.actionButtonText}>Edit</Text></Pressable>
              <Pressable onPress={onConfirmDelete} style={styles.actionButton}><Text style={styles.actionButtonTextDanger}>Delete</Text></Pressable>
            </View>
          )}
        </View>
      )}

      {expanded && editing && (
        <SaleEditor sale={sale} products={products} onCancel={onCancelEdit} onSaved={onSaved} />
      )}
    </View>
  );
}

type EditableItem = { productId: string; productName: string; unitPriceCents: number; quantity: number };

function SaleEditor({ sale, products, onCancel, onSaved }: { sale: Sale; products: Product[]; onCancel: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<EditableItem[]>(() =>
    (sale.items ?? [])
      .filter((item) => item.productId !== null)
      .map((item) => ({ productId: item.productId as string, productName: item.productName, unitPriceCents: item.unitPriceCents, quantity: item.quantity }))
  );
  const [payments, setPayments] = useState<PaymentLine[]>(() =>
    (sale.payments ?? []).map((p) => ({ method: p.method, amountCents: p.amountCents, tenderedCents: p.tenderedCents, customerName: p.customerName, customerPhone: p.customerPhone }))
  );
  const [droppedCount] = useState(() => (sale.items?.length ?? 0) - items.length);
  const [addSearch, setAddSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);

  const setQuantity = (productId: string, quantity: number) => {
    setItems((current) => (quantity === 0 ? current.filter((i) => i.productId !== productId) : current.map((i) => (i.productId === productId ? { ...i, quantity } : i))));
  };

  const addProduct = (product: Product) => {
    setItems((current) => {
      const existing = current.find((i) => i.productId === product.id);
      if (existing) return current.map((i) => (i.productId === product.id ? { ...i, quantity: i.quantity + 1 } : i));
      return [...current, { productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }];
    });
    setAddSearch('');
  };

  const matches = addSearch.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(addSearch.trim().toLowerCase()) && !items.some((i) => i.productId === p.id)).slice(0, 5)
    : [];

  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const canSave = items.length > 0 && paidCents === total && !submitting;

  const save = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    try {
      await editSale(sale.id, items.map((i) => ({ productId: i.productId, quantity: i.quantity })), payments);
      onSaved();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.detail}>
      {droppedCount > 0 && (
        <Text style={styles.warningText}>{droppedCount} item{droppedCount > 1 ? 's' : ''} from this sale no longer exist and were dropped.</Text>
      )}

      <Text style={styles.detailLabel}>ITEMS</Text>
      {items.map((item) => (
        <View key={item.productId} style={styles.editItemRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.detailItemName}>{item.productName}</Text>
            <Text style={styles.saleMeta}>{formatCents(item.unitPriceCents)} each</Text>
          </View>
          <QuantityStepper quantity={item.quantity} onChange={(next) => setQuantity(item.productId, next)} />
        </View>
      ))}

      <TextInput value={addSearch} onChangeText={setAddSearch} placeholder="+ Add a product…" placeholderTextColor="#999999" style={styles.addSearchInput} />
      {matches.length > 0 && (
        <View style={styles.matchList}>
          {matches.map((product) => (
            <Pressable key={product.id} onPress={() => addProduct(product)} style={styles.matchRow}>
              <Text style={styles.detailItemName}>{product.name}</Text>
              <Text style={styles.detailItemPrice}>{formatCents(product.priceCents)}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalValue}>{formatCents(total)}</Text>
      </View>

      <PaymentMethodPicker totalCents={total} payments={payments} onChange={setPayments} />

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.actionRow}>
        <Pressable onPress={save} disabled={!canSave} style={[styles.saveButton, !canSave && styles.saveButtonDisabled]}>
          <Text style={styles.saveButtonText}>{submitting ? 'Saving…' : 'Save changes'}</Text>
        </Pressable>
        <Pressable onPress={onCancel} style={styles.actionButton}><Text style={styles.actionButtonText}>Cancel</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 60 },
  title: { color: '#111111', fontSize: 26, fontWeight: '800', letterSpacing: -1, marginBottom: 20 },
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 13, marginBottom: 14, color: '#111111' },
  rangeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  rangeChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 16, backgroundColor: '#F2F2F2' },
  rangeChipActive: { backgroundColor: '#111111' },
  rangeChipText: { fontSize: 12, fontWeight: '700', color: '#555555' },
  rangeChipTextActive: { color: '#FFFFFF' },
  customRangeRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-end', marginBottom: 18 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  dateInput: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  applyButton: { backgroundColor: '#111111', height: 42, paddingHorizontal: 18, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  applyButtonDisabled: { backgroundColor: '#CCCCCC' },
  applyButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  list: { gap: 10 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, borderColor: '#ECECEC', overflow: 'hidden' },
  saleRow: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  saleItems: { color: '#111111', fontSize: 13, fontWeight: '700' },
  saleMeta: { color: '#999999', fontSize: 11, marginTop: 3 },
  saleTotal: { color: '#111111', fontSize: 14, fontWeight: '800' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
  warningText: { color: '#B5793A', fontSize: 12, fontWeight: '600', marginBottom: 10 },

  detail: { padding: 14, paddingTop: 0, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  detailLabel: { fontSize: 10, fontWeight: '800', color: '#999999', letterSpacing: 0.6, marginTop: 12, marginBottom: 6 },
  detailRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  detailItemName: { fontSize: 13, fontWeight: '700', color: '#111111', flex: 1 },
  detailItemPrice: { fontSize: 13, fontWeight: '700', color: '#111111' },

  historyToggle: { fontSize: 12, fontWeight: '700', color: '#999999' },
  historyList: { gap: 10, marginTop: 10 },
  historyEntry: { backgroundColor: '#F2F2F2', borderRadius: 10, padding: 10 },
  historyDate: { fontSize: 11, fontWeight: '700', color: '#777777', marginBottom: 4 },
  historyItem: { fontSize: 12, color: '#555555', marginTop: 1 },
  historyTotal: { fontSize: 12, fontWeight: '700', color: '#111111', marginTop: 4 },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 14, alignItems: 'center' },
  actionButton: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#F2F2F2' },
  actionButtonText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  actionButtonTextDanger: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 },
  confirmText: { flex: 1, fontSize: 12, fontWeight: '600', color: '#111111' },
  confirmDanger: { fontSize: 12, fontWeight: '800', color: '#C0392B' },
  confirmCancel: { fontSize: 12, fontWeight: '700', color: '#999999' },

  editItemRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 10, padding: 10, marginBottom: 6 },
  addSearchInput: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 12, color: '#111111', marginTop: 8 },
  matchList: { marginTop: 6, gap: 4 },
  matchRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 10, padding: 10 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#ECECEC', marginTop: 12 },
  totalLabel: { color: '#111111', fontSize: 13, fontWeight: '800' },
  totalValue: { color: '#111111', fontSize: 20, fontWeight: '800' },
  saveButton: { backgroundColor: '#111111', paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10 },
  saveButtonDisabled: { backgroundColor: '#CCCCCC' },
  saveButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
});
