import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';

import { useHeaderActions, type HeaderActionsSetter, useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { pillStyles, SaleDetailPanel } from '@/components/accounting/sale-detail-panel';
import { Badge } from '@/components/badge';
import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { CustomerPicker, type SelectedCustomer } from '@/components/customer-picker';
import { ExportMenu } from '@/components/export-menu';
import { PaymentMethodPicker } from '@/components/payment-method-picker';
import { QuantityStepper } from '@/components/quantity-stepper';
import type { DateRange } from '@/components/range-selector';
import { ReceiptModal } from '@/components/receipt-modal';
import { RefundModal, refundedQtyFor } from '@/components/refund-modal';
import { StatTile } from '@/components/stat-tile';
import { BentoFlow } from '@/components/ui/bento';
import { formatRangeLabel as baseFormatRangeLabel, type LabelPreset } from '@/lib/range-label';
import { BentoCard } from '@/components/ui/bento-card';
import { useAuth } from '@/hooks/use-auth';
import type { CsvColumn } from '@/lib/csv';
import { formatCents, formatCompactCents } from '@/lib/currency';
import { listProducts } from '@/lib/products';
import { hasMultipleLocations } from '@/lib/location-selection';
import { buildReceiptFromSale } from '@/lib/receipt';
import { deleteSale, editSale, listSalesInRange } from '@/lib/sales';
import { type AcceptedSale, runSalesImport, SALES_EXAMPLE_ROWS, SALES_TEMPLATE_COLUMNS } from '@/lib/sales-import';
import { saleProfit, saleRefundState, type SaleRefundState } from '@/lib/sales-reporting';
import { discountPercentLabel, saleDiscountSummary } from '@/lib/sale-discounts';
import { editedLineDiscountCents, editedSaleTotals } from '@/lib/sale-edit';
import type { PaymentLine, Product, Sale, SaleItemSnapshot, Shop } from '@/types/models';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

// The former Sales screen, now Accounting's Transactions tab. Behaviour is
// unchanged except that the date range comes from the Accounting shell (shared
// with Overview/Expenses/Reports) rather than this screen owning its own
// preset chips -- so switching tabs keeps the same window.

const paymentLabels: Record<string, string> = { cash: 'Cash', zaad: 'ZAAD', edahab: 'e-Dahab', other: 'Other', unpaid: 'Unpaid' };

// Read through a function rather than indexed directly. A sale taken on credit
// carries 'unpaid' until money arrives (migration 20260831000100), and any
// method this map has not met would otherwise render as the literal "undefined"
// in three columns and crash the search and the sort outright. The fallback
// shows the raw value, which is at least true and findable.
const paymentLabel = (method: string): string => paymentLabels[method] ?? method;

const SALE_EXPORT_COLUMNS: CsvColumn<Sale>[] = [
  { header: 'Date', value: (s) => new Date(s.createdAt).toLocaleString() },
  { header: 'Items', value: (s) => (s.items ?? []).map((i) => `${i.quantity}x ${i.productName}`).join('; ') },
  { header: 'Customer Name', value: (s) => s.customerName ?? '' },
  { header: 'Customer Phone', value: (s) => s.customerPhone ?? '' },
  { header: 'Customer Email', value: (s) => s.customerEmail ?? '' },
  { header: 'Payment Method', value: (s) => paymentLabel(s.paymentMethod) },
  { header: 'Cashier', value: (s) => s.cashierName ?? '' },
  // "Discount" keeps meaning the whole-sale discount, as it always has; the
  // columns around it add what the items had taken off, so a spreadsheet can
  // total everything a sale gave away.
  { header: 'List Subtotal', value: (s) => (discountsOf(s).listCents / 100).toFixed(2) },
  { header: 'Item Discounts', value: (s) => (discountsOf(s).itemDiscountCents / 100).toFixed(2) },
  { header: 'Discount', value: (s) => (s.discountCents / 100).toFixed(2) },
  { header: 'Total Off', value: (s) => (discountsOf(s).totalOffCents / 100).toFixed(2) },
  { header: 'Off %', value: (s) => { const d = discountsOf(s); return d.listCents > 0 ? ((d.totalOffCents * 100) / d.listCents).toFixed(1) : '0.0'; } },
  { header: 'Tax', value: (s) => (s.taxCents / 100).toFixed(2) },
  { header: 'Total', value: (s) => (s.totalCents / 100).toFixed(2) },
];
type SaleSortField = 'date' | 'customer' | 'payment' | 'total';

// What came back, said on the row rather than left for whoever opens it.
//
// The `↩` is load-bearing, not decoration: colour alone can't carry a state
// here, the same rule that makes StatementRow print its minus sign. And a
// partial refund is a COUNT, because the old `1↩` glyph rendered one unit
// coming back out of four identically to the whole basket coming back.
function RefundBadge({ state }: { state: SaleRefundState }) {
  if (state.kind === 'none') return null;
  if (state.kind === 'full') return <Badge label="↩ Refunded" tone="refund" variant="bento" />;
  return <Badge label={`↩ ${state.refundedQuantity} of ${state.totalQuantity} back`} tone="info" variant="bento" />;
}

// Neutral on purpose: an edit is bookkeeping, not money moving. It becomes a
// pill at the same time as the refund only because the two shared one
// overloaded Payment cell -- leaving this a bare glyph beside a pill would
// read as the lesser fact, which it isn't.
function discountsOf(sale: Sale) {
  return saleDiscountSummary({
    items: sale.items ?? [],
    discountCents: sale.discountCents,
    pointsRedeemedCents: sale.pointsRedeemedCents,
    taxCents: sale.taxCents,
    totalCents: sale.totalCents,
  });
}

// Amount AND share: a bare "50%" hides that it was 50 cents off a dollar item.
// Points are not counted -- see sale-discounts.ts.
function DiscountBadge({ offCents, percent }: { offCents: number; percent: string | null }) {
  if (offCents <= 0) return null;
  return <Badge label={`−${formatCents(offCents)}${percent ? ` · ${percent}` : ''}`} tone="info" variant="bento" />;
}

function EditBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <Badge label={count === 1 ? '✎ Edited' : `✎ Edited ${count}×`} tone="default" variant="bento" />;
}

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

// Re-exported so the three tabs that already import it from here keep working.
// The rule itself moved to lib/range-label.ts — it is preset-aware now, and a
// pure function in lib/ can be tested, which one living in a component file
// could not be.
//
// `SHARED_PRESETS` is duplicated from the Accounting shell rather than
// threaded through every tab's props: it is the same fixed list, and passing
// it down four levels to name a pill is not worth the churn. If the shell's
// presets change, change these together.
const SHELL_PRESETS: LabelPreset[] = [
  { label: 'Today', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

export function formatRangeLabel(range: DateRange): string {
  return baseFormatRangeLabel(range, SHELL_PRESETS);
}

export function TransactionsTab({
  dateRange,
  setHeaderActions,
  setRefresh,
}: {
  dateRange: DateRange;
  setHeaderActions: HeaderActionsSetter;
  setRefresh: RefreshSetter;
}) {
  const { shop, can, locations } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < 860;
  // `sales.view` is read-only history (receipts included); rewriting or
  // deleting a past sale needs `sales.edit`, which edit_sale/delete_sale
  // check server-side too. Refunding is its own permission, independent of
  // edit -- a role with sales.view (or even sales.edit) shouldn't be able to
  // issue refunds unless separately granted, which refund_sale_items also
  // enforces server-side.
  const canEdit = can('sales.edit');
  const canRefund = can('sales.refund');
  const [sales, setSales] = useState<Sale[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sortField, setSortField] = useState<SaleSortField>('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  // Tracks the FIRST fetch, not every fetch. `reload()` runs again after each
  // edit here, and swapping the rendered rows for a placeholder on those
  // collapsed the scroll content to a few pixels -- the platform then clamps
  // the scroll offset to fit, so the list came back at the top and whoever was
  // reading it lost their place after every change. Gating on "has anything
  // arrived yet" keeps the rows mounted, so they keep their height and their
  // position, and the values update underneath. First found in inventory.tsx.
  const [loaded, setLoaded] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  // null = every location. Combined is the default because it is what this
  // screen has always shown and what a single-location shop needs; the picker
  // below only appears once there is a second branch to pick.
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const showLocationFilter = hasMultipleLocations(locations);

  const { since: sinceDate, until: untilDate } = dateRange;

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      const [salesRows, productRows] = await Promise.all([
        listSalesInRange(shop.id, sinceDate, untilDate, undefined, locationFilter),
        listProducts(shop.id),
      ]);
      setSales(salesRows);
      setProducts(productRows);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [shop, sinceDate, untilDate, locationFilter]);

  useEffect(() => { reload(); }, [reload]);
  // Coming back to this screen on a phone, where the tab shell never unmounted
  // it, so its data is as old as the last time it was looked at.
  useRefreshOnFocus(reload);
  // Published to the shell, which owns the scroller the pull happens on.
  useTabRefresh(setRefresh, reload);

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
          paymentLabel(sale.paymentMethod).toLowerCase().includes(q)
        );
    const dir = sortDirection === 'asc' ? 1 : -1;
    return [...matches].sort((a, b) => {
      switch (sortField) {
        case 'date': return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir;
        case 'customer': return (a.customerName ?? '').localeCompare(b.customerName ?? '') * dir;
        case 'payment': return paymentLabel(a.paymentMethod).localeCompare(paymentLabel(b.paymentMethod)) * dir;
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
  const rangeLabel = formatRangeLabel(dateRange);

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
        unitLabel: 'sale',
      }
    : null;

  useHeaderActions(
    setHeaderActions,
    <>
      <ExportMenu variant="bento" rows={filtered} columns={SALE_EXPORT_COLUMNS} title="Sales" subtitle={rangeLabel} filenamePrefix="sales" />
      {canEdit && (
        <Pressable onPress={() => setShowImportModal(true)} style={styles.importButton}>
          <Text style={styles.importButtonText}>Import</Text>
        </Pressable>
      )}
    </>,
    [filtered, rangeLabel, canEdit]
  );

  // Flow, not a grid: this is a ledger. See BentoFlow's own note — a table in
  // a cell spans all twelve columns anyway and loses the cell's padding for
  // nothing, and on a phone it nests two horizontal scrollers.
  return (
    <BentoFlow>
      <BentoCard title="Sales in this range" scope={rangeLabel}>
        <View style={styles.metricRow}>
          <StatTile variant="bento" value={formatCompactCents(rangeTotalCents)} label={rangeLabel} />
          <StatTile variant="bento" value={String(filtered.length)} label="Orders" />
        </View>
      </BentoCard>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <BentoCard title="Transactions" scope={rangeLabel}>
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search by product, customer, or payment method"
        placeholderTextColor="#999999"
        style={styles.search}
      />

      {showLocationFilter && (
        <View style={styles.locationFilterRow}>
          <Pressable
            onPress={() => setLocationFilter(null)}
            style={[styles.locationChip, locationFilter === null && styles.locationChipActive]}
          >
            <Text style={[styles.locationChipText, locationFilter === null && styles.locationChipTextActive]}>All locations</Text>
          </Pressable>
          {locations.filter((location) => location.active).map((location) => (
            <Pressable
              key={location.id}
              onPress={() => setLocationFilter(location.id)}
              style={[styles.locationChip, locationFilter === location.id && styles.locationChipActive]}
            >
              <Text style={[styles.locationChipText, locationFilter === location.id && styles.locationChipTextActive]}>{location.name}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {!loaded ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : filtered.length === 0 ? (
        <Text style={styles.empty}>{search ? 'No sales match your search.' : 'No sales in this range.'}</Text>
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
              canRefund={canRefund}
              expanded={expandedId === sale.id}
              editing={editingId === sale.id}
              confirmingDelete={confirmDeleteId === sale.id}
              onToggle={() => setExpandedId((current) => (current === sale.id ? null : sale.id))}
              onStartEdit={() => { setEditingId(sale.id); setExpandedId(sale.id); }}
              onCancelEdit={() => setEditingId(null)}
              onSaved={async () => { setEditingId(null); await reload(); }}
              onRefunded={reload}
              onConfirmDelete={() => setConfirmDeleteId(sale.id)}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onDelete={() => handleDelete(sale.id)}
            />
          ))}
        </View>
      )}
      </BentoCard>

      {importConfig && (
        <CsvImportModal visible={showImportModal} onClose={() => setShowImportModal(false)} config={importConfig} onImported={reload} />
      )}
    </BentoFlow>
  );
}

// Declared at module scope rather than inside SalesTableHeader: a component
// defined during render is a fresh type on every pass, so React remounts it
// (discarding any state) each time the parent re-renders.
function HeaderCell({
  field,
  label,
  style,
  sortField,
  sortDirection,
  onSort,
}: {
  field: SaleSortField;
  label: string;
  style: object;
  sortField: SaleSortField;
  sortDirection: 'asc' | 'desc';
  onSort: (field: SaleSortField) => void;
}) {
  return (
    <Pressable onPress={() => onSort(field)} style={[styles.headerCell, style]}>
      <Text style={styles.headerLabel}>{label}</Text>
      {sortField === field && <Text style={styles.sortArrow}>{sortDirection === 'asc' ? '▲' : '▼'}</Text>}
    </Pressable>
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
  const sortProps = { sortField, sortDirection, onSort };
  return (
    <View style={styles.tableHeaderRow}>
      <View style={styles.dataCols}>
        <HeaderCell field="date" label="DATE" style={colDate} {...sortProps} />
        <Text style={[styles.headerLabel, colItems]}>ITEMS</Text>
        <HeaderCell field="customer" label="CUSTOMER" style={colCustomer} {...sortProps} />
        <HeaderCell field="payment" label="PAYMENT" style={colPayment} {...sortProps} />
        <Text style={[styles.headerLabel, colCashier]}>CASHIER</Text>
        <HeaderCell field="total" label="TOTAL" style={colTotal} {...sortProps} />
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
  canRefund,
  expanded,
  editing,
  confirmingDelete,
  onToggle,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onRefunded,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
}: {
  sale: Sale;
  products: Product[];
  compact: boolean;
  canEdit: boolean;
  canRefund: boolean;
  expanded: boolean;
  editing: boolean;
  confirmingDelete: boolean;
  onToggle: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onRefunded: () => Promise<void>;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const { shop, locations, hasModule } = useAuth();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [showRefund, setShowRefund] = useState(false);
  const editCount = sale.edits?.length ?? 0;
  const refundableCount = (sale.items ?? []).reduce((sum, item) => sum + Math.max(0, item.quantity - refundedQtyFor(sale, item.id)), 0);
  const itemsSummary = sale.items?.map((item) => `${item.quantity}× ${item.productName}`).join(', ') ?? '';
  const profit = saleProfit(sale);
  const refundState = saleRefundState(sale);
  const discounts = discountsOf(sale);

  return (
    <View style={[styles.card, !compact && styles.cardTableRow]}>
      {compact ? (
        <Pressable onPress={onToggle} style={styles.saleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.saleItems} numberOfLines={1}>{itemsSummary}</Text>
            <View style={styles.saleMetaRow}>
              <Text style={[styles.saleMeta, styles.saleMetaText]} numberOfLines={1}>
                {new Date(sale.createdAt).toLocaleString()} · {paymentLabel(sale.paymentMethod)}
                {sale.customerName ? ` · ${sale.customerName}` : ''}
              </Text>
              <DiscountBadge offCents={discounts.totalOffCents} percent={discounts.totalOffPercent} />
              <RefundBadge state={refundState} />
              <EditBadge count={editCount} />
            </View>
          </View>
          <Text style={styles.saleTotal}>{formatCents(sale.totalCents)}</Text>
        </Pressable>
      ) : (
        <Pressable onPress={onToggle} style={styles.tableRow}>
          <View style={styles.dataCols}>
            <Text style={[styles.cellText, colDate]} numberOfLines={1}>{new Date(sale.createdAt).toLocaleString()}</Text>
            <View style={[styles.itemsCell, colItems]}>
              {/* The name yields before the badge does: a truncated product is
                  still readable, a truncated badge is a mystery. */}
              <Text style={[styles.cellText, styles.itemsCellText]} numberOfLines={1}>{itemsSummary}</Text>
              <DiscountBadge offCents={discounts.totalOffCents} percent={discounts.totalOffPercent} />
              <RefundBadge state={refundState} />
              <EditBadge count={editCount} />
            </View>
            <Text style={[styles.cellText, styles.muted, colCustomer]} numberOfLines={1}>{sale.customerName || '—'}</Text>
            <Text style={[styles.cellText, colPayment]} numberOfLines={1}>{paymentLabel(sale.paymentMethod)}</Text>
            <Text style={[styles.cellText, styles.muted, colCashier]} numberOfLines={1}>{sale.cashierName || '—'}</Text>
            <Text style={[styles.cellText, styles.price, colTotal]} numberOfLines={1}>{formatCents(sale.totalCents)}</Text>
          </View>
          <View style={styles.colExpand}>
            <Text style={styles.expandIcon}>{expanded ? '▴' : '▾'}</Text>
          </View>
        </Pressable>
      )}

      {expanded && !editing && (
        <SaleDetailPanel
          sale={sale}
          compact={compact}
          discounts={discounts}
          profit={profit}
          storeName={hasMultipleLocations(locations) ? locations.find((location) => location.id === sale.locationId)?.name ?? null : null}
          actions={
            confirmingDelete ? (
              <>
                <Text style={styles.confirmText}>Delete this sale? Stock will be restored.</Text>
                <Pressable onPress={onDelete} role="button" style={[pillStyles.pill, pillStyles.danger]}><Text style={[pillStyles.pillText, pillStyles.dangerText]}>Confirm delete</Text></Pressable>
                <Pressable onPress={onCancelDelete} role="button" style={[pillStyles.pill, pillStyles.quiet]}><Text style={[pillStyles.pillText, pillStyles.quietText]}>Cancel</Text></Pressable>
              </>
            ) : (
              <>
                <Pressable onPress={() => setShowReceipt(true)} role="button" style={pillStyles.pill}><Text style={pillStyles.pillText}>🧾 Receipt</Text></Pressable>
                {canEdit && (
                  <Pressable onPress={onStartEdit} role="button" style={pillStyles.pill}><Text style={pillStyles.pillText}>✎ Edit</Text></Pressable>
                )}
                {canRefund && refundableCount > 0 && (
                  <Pressable onPress={() => setShowRefund(true)} role="button" style={pillStyles.pill}><Text style={pillStyles.pillText}>↩ Refund</Text></Pressable>
                )}
                {canEdit && (
                  <Pressable onPress={onConfirmDelete} role="button" style={[pillStyles.pill, pillStyles.danger]}><Text style={[pillStyles.pillText, pillStyles.dangerText]}>Delete</Text></Pressable>
                )}
              </>
            )
          }
          footer={editCount > 0 ? (
            <View>
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
                          <Text style={styles.historyTotal}>Total: {formatCents(edit.previousSnapshot.totalCents)} · {paymentLabel(edit.previousSnapshot.paymentMethod)}</Text>
                        </View>
                      ))}
                    </View>
                  )}
            </View>
          ) : null}
        />
      )}

      {expanded && editing && (
        <SaleEditor sale={sale} products={products} shop={shop} onCancel={onCancelEdit} onSaved={onSaved} />
      )}

      {/* Reprints carry the branch the sale was actually rung up at, not
          whichever one this device happens to be set to now. */}
      {shop && (
        <ReceiptModal
          receipt={
            showReceipt
              ? buildReceiptFromSale(
                  sale,
                  shop,
                  locations.find((location) => location.id === sale.locationId) ?? null,
                  hasMultipleLocations(locations),
                  !hasModule('receipt_branding_removal')
                )
              : null
          }
          onClose={() => setShowReceipt(false)}
          title="Receipt"
        />
      )}
      <RefundModal
        visible={showRefund}
        sale={sale}
        onClose={() => setShowRefund(false)}
        onRefunded={async () => { setShowRefund(false); await onRefunded(); }}
      />
    </View>
  );
}

// `discountCents`/`promotionId` ride along unchanged from the original sale
// item -- edit_sale rewrites every sale_items row on save, so a caller that
// drops these silently zeroes the line's discount and detaches whatever
// promotion produced it. Quantity/price are the only fields this editor
// actually lets someone change.
type EditableItem = { productId: string; productName: string; unitPriceCents: number; quantity: number; originalQuantity: number; discountCents: number; promotionId: string | null; promotionName: string | null };

function SaleEditor({ sale, products, shop, onCancel, onSaved }: { sale: Sale; products: Product[]; shop: Shop | null; onCancel: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<EditableItem[]>(() =>
    (sale.items ?? [])
      .filter((item) => item.productId !== null)
      .map((item) => ({
        productId: item.productId as string,
        productName: item.productName,
        unitPriceCents: item.unitPriceCents,
        quantity: item.quantity,
        originalQuantity: item.quantity,
        discountCents: item.discountCents,
        promotionId: item.promotionId,
        promotionName: item.promotionName,
      }))
  );
  // Settlements are excluded. edit_sale deletes and re-inserts only the till's own
  // payment rows and preserves settlements itself, so seeding them here and
  // sending them back would count the same money twice -- an over-payment
  // refusal on a settled credit sale, and a Save button that never enables on a
  // part-paid one.
  const [payments, setPayments] = useState<PaymentLine[]>(() =>
    (sale.payments ?? []).filter((p) => !p.isSettlement).map((p) => ({
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
    // pointsBalance is 0 rather than the customer's real balance: the sale
    // editor has no redemption control, so nothing here reads it, and fetching
    // a live balance just to satisfy the type would be a query for nothing.
    sale.customerId
      ? { id: sale.customerId, name: sale.customerName ?? '', phone: sale.customerPhone, email: sale.customerEmail, pointsBalance: 0, availablePoints: null }
      : null
  );
  const [droppedCount] = useState(() => (sale.items?.length ?? 0) - items.length);
  const [addSearch, setAddSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // edit_sale re-prices every line at the product's CURRENT price, so the
  // editor does too -- showing the sale-time price would put a total on screen
  // the server then refuses to match. Falls back to the sale-time price while
  // the product list is still loading.
  const lines = items.map((item) => {
    const unitPriceCents = products.find((p) => p.id === item.productId)?.priceCents ?? item.unitPriceCents;
    return {
      ...item,
      unitPriceCents,
      discountCents: editedLineDiscountCents({ discountCents: item.discountCents, originalQuantity: item.originalQuantity, quantity: item.quantity, unitPriceCents }),
    };
  });
  const totals = editedSaleTotals({
    lines,
    saleDiscountCents: sale.discountCents,
    pointsRedeemedCents: sale.pointsRedeemedCents,
    taxRatePercent: shop?.taxEnabled ? shop.taxRatePercent : null,
  });
  const taxCents = totals.taxCents;
  const total = totals.totalCents;

  const setQuantity = (productId: string, quantity: number) => {
    setItems((current) => (quantity === 0 ? current.filter((i) => i.productId !== productId) : current.map((i) => (i.productId === productId ? { ...i, quantity } : i))));
  };

  const addProduct = (product: Product) => {
    setItems((current) => {
      const existing = current.find((i) => i.productId === product.id);
      if (existing) return current.map((i) => (i.productId === product.id ? { ...i, quantity: i.quantity + 1 } : i));
      // A product added during the edit has no discount and no promotion
      // behind it -- it's new to this sale, not a preserved line.
      return [...current, { productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1, originalQuantity: 0, discountCents: 0, promotionId: null, promotionName: null }];
    });
    setAddSearch('');
  };

  const matches = addSearch.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(addSearch.trim().toLowerCase()) && !items.some((i) => i.productId === p.id)).slice(0, 5)
    : [];

  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  // What settlements already collected -- neither shown nor re-sent by this
  // editor, but still counting towards the sale being covered.
  const settledCents = (sale.payments ?? [])
    .filter((p) => p.isSettlement)
    .reduce((sum, p) => sum + p.amountCents, 0);
  // A sale on credit stays on credit through an edit: Save enables at a shortfall
  // rather than demanding the cashier top it up to the total, which is not what
  // editing a basket is for. An OVER-payment is still refused, as the server
  // refuses it.
  const carriesBalance = sale.settledAt === null && Boolean(selectedCustomer);
  const coveredCents = paidCents + settledCents;
  const canSave =
    items.length > 0 && !submitting &&
    (coveredCents === total || (carriesBalance && coveredCents < total));

  // A greyed-out Save with no word on why reads as a broken button.
  const saveBlockedReason =
    items.length === 0 ? 'A sale needs at least one item.'
    : coveredCents > total ? `Payments are ${formatCents(coveredCents - total)} more than the total — remove one and re-add it.`
    : coveredCents < total && !carriesBalance
      ? !selectedCustomer
        ? `${formatCents(total - coveredCents)} is still unpaid — add a payment, or pick a customer to leave it as a balance.`
        : `${formatCents(total - coveredCents)} is still unpaid — add a payment to cover it.`
    : null;

  const save = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    try {
      await editSale(sale.id, lines.map((i) => ({ productId: i.productId, quantity: i.quantity, discountCents: i.discountCents, promotionId: i.promotionId })), payments, {
        id: selectedCustomer?.id ?? null,
        name: selectedCustomer?.name ?? null,
        phone: selectedCustomer?.phone ?? null,
        email: selectedCustomer?.email ?? null,
      }, totals.saleDiscountCents, carriesBalance && coveredCents < total);
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
      {lines.map((item) => (
        <View key={item.productId} style={styles.editItemRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.detailItemName}>{item.productName}</Text>
            <Text style={styles.saleMeta}>
              {formatCents(item.unitPriceCents)} each
              {item.discountCents > 0 ? (
                <Text style={styles.itemOff}>
                  {` · −${formatCents(item.discountCents)}`}
                  {discountPercentLabel(item.discountCents, item.unitPriceCents * item.quantity) ? ` · ${discountPercentLabel(item.discountCents, item.unitPriceCents * item.quantity)}` : ''}
                  {` · ${item.promotionName ?? (sale.cashierName ? `Manual discount by ${sale.cashierName}` : 'Manual discount')}`}
                </Text>
              ) : null}
            </Text>
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

      {(totals.saleDiscountCents > 0 || sale.pointsRedeemedCents > 0) && (
        <View style={styles.detailRow}>
          <Text style={styles.saleMeta}>{totals.saleDiscountCents > 0 ? 'Sale discount' : 'Points redeemed'}{totals.saleDiscountCents > 0 && sale.pointsRedeemedCents > 0 ? ' + points' : ''}</Text>
          <Text style={styles.detailItemPrice}>−{formatCents(totals.saleDiscountCents + sale.pointsRedeemedCents)}</Text>
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
      {saveBlockedReason && <Text style={styles.warningText}>{saveBlockedReason}</Text>}

      <View style={styles.actionRow}>
        {/* Save commits, so it takes the solid blue; Cancel only closes. */}
        <Pressable onPress={save} disabled={!canSave} role="button" style={[pillStyles.pill, pillStyles.solid, !canSave && pillStyles.disabled]}>
          <Text style={[pillStyles.pillText, pillStyles.solidText, !canSave && pillStyles.disabledText]}>{submitting ? 'Saving…' : 'Save changes'}</Text>
        </Pressable>
        <Pressable onPress={onCancel} role="button" style={[pillStyles.pill, pillStyles.quiet]}><Text style={[pillStyles.pillText, pillStyles.quietText]}>Cancel</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  importButton: { backgroundColor: theme.bentoAccentSolid, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  importButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  // No bottom margin: the card around this owns its padding now, and keeping
  // one here left a dead band under the tiles.
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 13, marginBottom: 14, color: '#111111' },
  locationFilterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  locationChip: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  locationChipActive: { backgroundColor: '#111111' },
  locationChipText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  locationChipTextActive: { color: '#FFFFFF' },
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
  // Shrink is applied HERE rather than on `saleMeta`, which seven other call
  // sites share as a plain column child -- there the main axis is vertical and
  // a shrink factor would let the line clip rather than ellipsize. Same job as
  // `itemsCellText` does for the table row.
  saleMetaText: { flexShrink: 1 },
  // `flexShrink: 1` on the text and nothing on the badge: the badge is the
  // short, fixed thing, so the product name is what gives way when the column
  // runs out. `minWidth: 0` is what lets it, in both rows.
  itemsCell: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  itemsCellText: { flexShrink: 1 },
  saleMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' },
  saleTotal: { color: '#111111', fontSize: 14, fontWeight: '800' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
  warningText: { color: '#B5793A', fontSize: 12, fontWeight: '600', marginBottom: 10 },

  detail: { padding: 14, paddingTop: 0, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  detailLabel: { fontSize: 10, fontWeight: '800', color: '#999999', letterSpacing: 0.6, marginTop: 12, marginBottom: 6 },
  detailRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  detailItemName: { fontSize: 13, fontWeight: '700', color: '#111111', flex: 1 },
  detailItemPrice: { fontSize: 13, fontWeight: '700', color: '#111111' },


  // The bento accent, as the list's discount tag: blue is "taken off" on this
  // screen, never a status.
  itemOff: { fontSize: 12.5, fontWeight: '700', color: theme.bentoAccentInk, lineHeight: 18 },

  historyToggle: { fontSize: 12, fontWeight: '700', color: '#999999' },
  historyList: { gap: 10, marginTop: 10 },
  historyEntry: { backgroundColor: '#F2F2F2', borderRadius: 10, padding: 10 },
  historyDate: { fontSize: 11, fontWeight: '700', color: '#777777', marginBottom: 4 },
  historyItem: { fontSize: 12, color: '#555555', marginTop: 1 },
  historyTotal: { fontSize: 12, fontWeight: '700', color: '#111111', marginTop: 4 },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 14, alignItems: 'center' },
  confirmText: { flex: 1, fontSize: 12, fontWeight: '600', color: '#111111' },

  editItemRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 10, padding: 10, marginBottom: 6 },
  addSearchInput: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 12, color: '#111111', marginTop: 8 },
  matchList: { marginTop: 6, gap: 4 },
  matchRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 10, padding: 10 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#ECECEC', marginTop: 12 },
  totalLabel: { color: '#111111', fontSize: 13, fontWeight: '800' },
  totalValue: { color: '#111111', fontSize: 20, fontWeight: '800' },
});
