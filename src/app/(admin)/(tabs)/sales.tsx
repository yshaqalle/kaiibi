import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { CustomerPicker, type SelectedCustomer } from '@/components/customer-picker';
import { DateInput, parseDateInput } from '@/components/date-input';
import { ExportMenu } from '@/components/export-menu';
import { PaymentMethodPicker } from '@/components/payment-method-picker';
import { QuantityStepper } from '@/components/quantity-stepper';
import { ReceiptModal } from '@/components/receipt-modal';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import type { CsvColumn } from '@/lib/csv';
import { formatCents } from '@/lib/currency';
import { listProducts } from '@/lib/products';
import { buildReceiptFromSale } from '@/lib/receipt';
import { deleteSale, editSale, listSalesInRange } from '@/lib/sales';
import { type AcceptedSale, runSalesImport, SALES_EXAMPLE_ROWS, SALES_TEMPLATE_COLUMNS } from '@/lib/sales-import';
import { taxCentsFor } from '@/lib/tax';
import type { PaymentLine, Product, Sale, SaleItemSnapshot, Shop } from '@/types/models';

const paymentLabels: Record<Sale['paymentMethod'], string> = { cash: 'Cash', zaad: 'ZAAD', edahab: 'e-Dahab', other: 'Other' };

const SALE_EXPORT_COLUMNS: CsvColumn<Sale>[] = [
  { header: 'Date', value: (s) => new Date(s.createdAt).toLocaleString() },
  { header: 'Items', value: (s) => (s.items ?? []).map((i) => `${i.quantity}x ${i.productName}`).join('; ') },
  { header: 'Customer Name', value: (s) => s.customerName ?? '' },
  { header: 'Customer Phone', value: (s) => s.customerPhone ?? '' },
  { header: 'Customer Email', value: (s) => s.customerEmail ?? '' },
  { header: 'Payment Method', value: (s) => paymentLabels[s.paymentMethod] },
  { header: 'Cashier', value: (s) => s.cashierName ?? '' },
  { header: 'Discount', value: (s) => (s.discountCents / 100).toFixed(2) },
  { header: 'Tax', value: (s) => (s.taxCents / 100).toFixed(2) },
  { header: 'Total', value: (s) => (s.totalCents / 100).toFixed(2) },
];
const rangePresets = [7, 14, 30, 90] as const;
type SaleSortField = 'date' | 'customer' | 'payment' | 'total';

// Column widths as plain inline objects, not StyleSheet.create entries —
// see product-table-row.tsx for why (RN's Text/View style types disagree
// on some properties, so a shared const can't be typed to satisfy both).
const colDate = { flexBasis: '16%', flexGrow: 0, flexShrink: 0 } as const;
const colItems = { flexBasis: '26%', flexGrow: 0, flexShrink: 0 } as const;
const colCustomer = { flexBasis: '16%', flexGrow: 0, flexShrink: 0 } as const;
const colPayment = { flexBasis: '12%', flexGrow: 0, flexShrink: 0 } as const;
const colCashier = { flexBasis: '12%', flexGrow: 0, flexShrink: 0 } as const;
const colTotal = { flexBasis: '12%', flexGrow: 0, flexShrink: 0 } as const;

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export default function SalesScreen() {
  const { shop, can } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < 860;
  // `sales.view` is read-only history (receipts included); rewriting or
  // deleting a past sale needs `sales.edit`, which edit_sale/delete_sale
  // check server-side too.
  const canEdit = can('sales.edit');
  const [sales, setSales] = useState<Sale[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [daysBack, setDaysBack] = useState<number>(14);
  const [sortField, setSortField] = useState<SaleSortField>('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
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
  const [showImportModal, setShowImportModal] = useState(false);

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
    const matches = !q
      ? sales
      : sales.filter((sale) =>
          (sale.items ?? []).some((item) => item.productName.toLowerCase().includes(q)) ||
          (sale.payments ?? []).some((p) => (p.customerName ?? '').toLowerCase().includes(q) || (p.customerPhone ?? '').toLowerCase().includes(q)) ||
          (sale.customerName ?? '').toLowerCase().includes(q) ||
          (sale.customerPhone ?? '').toLowerCase().includes(q) ||
          (sale.customerEmail ?? '').toLowerCase().includes(q) ||
          (sale.cashierName ?? '').toLowerCase().includes(q) ||
          paymentLabels[sale.paymentMethod].toLowerCase().includes(q)
        );
    const dir = sortDirection === 'asc' ? 1 : -1;
    return [...matches].sort((a, b) => {
      switch (sortField) {
        case 'date': return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir;
        case 'customer': return (a.customerName ?? '').localeCompare(b.customerName ?? '') * dir;
        case 'payment': return paymentLabels[a.paymentMethod].localeCompare(paymentLabels[b.paymentMethod]) * dir;
        case 'total': return (a.totalCents - b.totalCents) * dir;
      }
    });
  }, [sales, search, sortField, sortDirection]);

  const toggleSort = (field: SaleSortField) => {
    if (sortField === field) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'date' || field === 'total' ? 'desc' : 'asc');
    }
  };

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

  const importConfig: ImportEntityConfig<AcceptedSale> | null = shop
    ? {
        title: 'sales',
        filenamePrefix: 'sales',
        templateColumns: SALES_TEMPLATE_COLUMNS,
        exampleRows: SALES_EXAMPLE_ROWS,
        run: (parsed) => runSalesImport(shop, parsed),
      }
    : null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Sales</Text>
          <View style={styles.headerActions}>
            <ExportMenu rows={filtered} columns={SALE_EXPORT_COLUMNS} title="Sales" subtitle={rangeLabel} filenamePrefix="sales" />
            {canEdit && (
              <Pressable onPress={() => setShowImportModal(true)} style={styles.importButton}>
                <Text style={styles.importButtonText}>Import</Text>
              </Pressable>
            )}
          </View>
        </View>
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
              <DateInput value={customStartInput} onChangeText={setCustomStartInput} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>TO</Text>
              <DateInput value={customEndInput} onChangeText={setCustomEndInput} />
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
          <View style={[styles.list, !compact && styles.listTable]}>
            {!compact && <SalesTableHeader sortField={sortField} sortDirection={sortDirection} onSort={toggleSort} />}
            {filtered.map((sale) => (
              <SaleRow
                key={sale.id}
                sale={sale}
                products={products}
                compact={compact}
                canEdit={canEdit}
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
      {importConfig && (
        <CsvImportModal visible={showImportModal} onClose={() => setShowImportModal(false)} config={importConfig} onImported={reload} />
      )}
    </SafeAreaView>
  );
}

function SalesTableHeader({
  sortField,
  sortDirection,
  onSort,
}: {
  sortField: SaleSortField;
  sortDirection: 'asc' | 'desc';
  onSort: (field: SaleSortField) => void;
}) {
  const HeaderCell = ({ field, label, style }: { field: SaleSortField; label: string; style: object }) => (
    <Pressable onPress={() => onSort(field)} style={[styles.headerCell, style]}>
      <Text style={styles.headerLabel}>{label}</Text>
      {sortField === field && <Text style={styles.sortArrow}>{sortDirection === 'asc' ? '▲' : '▼'}</Text>}
    </Pressable>
  );

  return (
    <View style={styles.tableHeaderRow}>
      <View style={styles.dataCols}>
        <HeaderCell field="date" label="DATE" style={colDate} />
        <Text style={[styles.headerLabel, colItems]}>ITEMS</Text>
        <HeaderCell field="customer" label="CUSTOMER" style={colCustomer} />
        <HeaderCell field="payment" label="PAYMENT" style={colPayment} />
        <Text style={[styles.headerLabel, colCashier]}>CASHIER</Text>
        <HeaderCell field="total" label="TOTAL" style={colTotal} />
      </View>
      <View style={styles.colExpand} />
    </View>
  );
}

function SaleRow({
  sale,
  products,
  compact,
  canEdit,
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
  compact: boolean;
  canEdit: boolean;
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
  const { shop } = useAuth();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const editCount = sale.edits?.length ?? 0;
  const itemsSummary = sale.items?.map((item) => `${item.quantity}× ${item.productName}`).join(', ') ?? '';

  return (
    <View style={[styles.card, !compact && styles.cardTableRow]}>
      {compact ? (
        <Pressable onPress={onToggle} style={styles.saleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.saleItems} numberOfLines={1}>{itemsSummary}</Text>
            <Text style={styles.saleMeta}>
              {new Date(sale.createdAt).toLocaleString()} · {paymentLabels[sale.paymentMethod]}
              {sale.customerName ? ` · ${sale.customerName}` : ''}
              {editCount > 0 ? ` · Edited ${editCount}×` : ''}
            </Text>
          </View>
          <Text style={styles.saleTotal}>{formatCents(sale.totalCents)}</Text>
        </Pressable>
      ) : (
        <Pressable onPress={onToggle} style={styles.tableRow}>
          <View style={styles.dataCols}>
            <Text style={[styles.cellText, colDate]} numberOfLines={1}>{new Date(sale.createdAt).toLocaleString()}</Text>
            <Text style={[styles.cellText, colItems]} numberOfLines={1}>{itemsSummary}</Text>
            <Text style={[styles.cellText, styles.muted, colCustomer]} numberOfLines={1}>{sale.customerName || '—'}</Text>
            <Text style={[styles.cellText, colPayment]} numberOfLines={1}>{paymentLabels[sale.paymentMethod]}{editCount > 0 ? ` · ${editCount}✎` : ''}</Text>
            <Text style={[styles.cellText, styles.muted, colCashier]} numberOfLines={1}>{sale.cashierName || '—'}</Text>
            <Text style={[styles.cellText, styles.price, colTotal]} numberOfLines={1}>{formatCents(sale.totalCents)}</Text>
          </View>
          <View style={styles.colExpand}>
            <Text style={styles.expandIcon}>{expanded ? '▴' : '▾'}</Text>
          </View>
        </Pressable>
      )}

      {expanded && !editing && (
        <View style={styles.detail}>
          {(sale.customerName || sale.customerPhone || sale.customerEmail) && (
            <>
              <Text style={styles.detailLabel}>CUSTOMER</Text>
              {sale.customerName && <Text style={styles.detailItemName}>{sale.customerName}</Text>}
              {sale.customerPhone && <Text style={styles.saleMeta}>{sale.customerPhone}</Text>}
              {sale.customerEmail && <Text style={styles.saleMeta}>{sale.customerEmail}</Text>}
            </>
          )}

          <Text style={[styles.detailLabel, (sale.customerName || sale.customerPhone || sale.customerEmail) && { marginTop: 14 }]}>ITEMS</Text>
          <View style={styles.itemsList}>
            {sale.items?.map((item, index) => (
              <View key={item.id} style={[styles.itemRow, index === (sale.items?.length ?? 0) - 1 && styles.itemRowLast]}>
                <Text style={styles.itemQty}>{item.quantity}×</Text>
                <Text style={styles.itemName}>{item.productName}</Text>
                <Text style={styles.itemPrice}>{formatCents(item.lineTotalCents)}</Text>
              </View>
            ))}
          </View>

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
                      {(edit.previousSnapshot.customerName || edit.previousSnapshot.customerPhone || edit.previousSnapshot.customerEmail) && (
                        <Text style={styles.historyItem}>
                          {[edit.previousSnapshot.customerName, edit.previousSnapshot.customerPhone, edit.previousSnapshot.customerEmail].filter(Boolean).join(' · ')}
                        </Text>
                      )}
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
              <Pressable onPress={() => setShowReceipt(true)} style={styles.actionButton}><Text style={styles.actionButtonText}>Receipt</Text></Pressable>
              {canEdit && (
                <>
                  <Pressable onPress={onStartEdit} style={styles.actionButton}><Text style={styles.actionButtonText}>Edit</Text></Pressable>
                  <Pressable onPress={onConfirmDelete} style={styles.actionButton}><Text style={styles.actionButtonTextDanger}>Delete</Text></Pressable>
                </>
              )}
            </View>
          )}
        </View>
      )}

      {expanded && editing && (
        <SaleEditor sale={sale} products={products} shop={shop} onCancel={onCancelEdit} onSaved={onSaved} />
      )}

      {shop && <ReceiptModal receipt={showReceipt ? buildReceiptFromSale(sale, shop) : null} onClose={() => setShowReceipt(false)} title="Receipt" />}
    </View>
  );
}

type EditableItem = { productId: string; productName: string; unitPriceCents: number; quantity: number };

function SaleEditor({ sale, products, shop, onCancel, onSaved }: { sale: Sale; products: Product[]; shop: Shop | null; onCancel: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<EditableItem[]>(() =>
    (sale.items ?? [])
      .filter((item) => item.productId !== null)
      .map((item) => ({ productId: item.productId as string, productName: item.productName, unitPriceCents: item.unitPriceCents, quantity: item.quantity }))
  );
  const [payments, setPayments] = useState<PaymentLine[]>(() =>
    (sale.payments ?? []).map((p) => ({
      method: p.method,
      amountCents: p.amountCents,
      tenderedCents: p.tenderedCents,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      currencyCode: p.currencyCode,
      exchangeRate: p.exchangeRate,
      foreignAmountCents: p.foreignAmountCents,
      foreignChangeCents: p.foreignChangeCents,
    }))
  );
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(
    sale.customerId ? { id: sale.customerId, name: sale.customerName ?? '', phone: sale.customerPhone, email: sale.customerEmail } : null
  );
  const [droppedCount] = useState(() => (sale.items?.length ?? 0) - items.length);
  const [addSearch, setAddSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preTaxTotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  const taxCents = shop?.taxEnabled ? taxCentsFor(preTaxTotalCents, shop.taxRatePercent) : 0;
  const total = preTaxTotalCents + taxCents;

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
      await editSale(sale.id, items.map((i) => ({ productId: i.productId, quantity: i.quantity })), payments, {
        id: selectedCustomer?.id ?? null,
        name: selectedCustomer?.name ?? null,
        phone: selectedCustomer?.phone ?? null,
        email: selectedCustomer?.email ?? null,
      });
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

      <Text style={styles.detailLabel}>CUSTOMER (OPTIONAL)</Text>
      {shop && (
        <CustomerPicker
          shopId={shop.id}
          selected={selectedCustomer}
          onSelect={setSelectedCustomer}
          onClear={() => setSelectedCustomer(null)}
        />
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

      {taxCents > 0 && (
        <View style={styles.detailRow}>
          <Text style={styles.saleMeta}>Tax ({shop?.taxRatePercent}%)</Text>
          <Text style={styles.detailItemPrice}>{formatCents(taxCents)}</Text>
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
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 20 },
  title: { color: '#111111', fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  importButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  importButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 13, marginBottom: 14, color: '#111111' },
  rangeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  rangeChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 16, backgroundColor: '#F2F2F2' },
  rangeChipActive: { backgroundColor: '#111111' },
  rangeChipText: { fontSize: 12, fontWeight: '700', color: '#555555' },
  rangeChipTextActive: { color: '#FFFFFF' },
  customRangeRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-end', marginBottom: 18 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  applyButton: { backgroundColor: '#111111', height: 42, paddingHorizontal: 18, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  applyButtonDisabled: { backgroundColor: '#CCCCCC' },
  applyButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  list: { gap: 10 },
  listTable: { gap: 0 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, borderColor: '#ECECEC', overflow: 'hidden' },
  cardTableRow: { borderRadius: 0, borderWidth: 1, borderColor: '#ECECEC', borderTopWidth: 0 },
  saleRow: { flexDirection: 'row', alignItems: 'center', padding: 14 },

  tableHeaderRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#ECECEC', borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  headerCell: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerLabel: { fontSize: 10, fontWeight: '900', color: '#555555', letterSpacing: 0.6 },
  sortArrow: { fontSize: 8, color: '#555555' },
  // Same fix as product-table-row.tsx: the six percentage-width columns
  // resolve against this flex:1 wrapper's own width, not the whole row, so
  // the fixed-width trailing chevron (a sibling, not part of the percentage
  // group) doesn't push the row past 100% and get clipped off-screen.
  dataCols: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  cellText: { fontSize: 13, color: '#111111' },
  muted: { color: '#999999' },
  price: { fontWeight: '800' },
  tableRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  colExpand: { width: 20, alignItems: 'flex-end' },
  expandIcon: { color: '#999999', fontSize: 12, fontWeight: '800' },
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

  itemsList: { backgroundColor: '#FAFAFA', borderRadius: 10, paddingHorizontal: 12 },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#EFEFEF' },
  itemRowLast: { borderBottomWidth: 0 },
  itemQty: { fontSize: 13, fontWeight: '700', color: '#999999', marginRight: 6, lineHeight: 18 },
  itemName: { fontSize: 13, fontWeight: '600', color: '#111111', flex: 1, marginRight: 12, lineHeight: 18 },
  itemPrice: { fontSize: 13, fontWeight: '700', color: '#111111', lineHeight: 18 },

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

  editCustomerRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  editCustomerInput: { flex: 1, backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 12, color: '#111111' },
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
