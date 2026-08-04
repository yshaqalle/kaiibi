import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/card';
import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { ExportMenu } from '@/components/export-menu';
import { ProductModal } from '@/components/product-modal';
import { StoreDropdown } from '@/components/store-dropdown';
import { StockByStoreModal } from '@/components/stock-by-store-modal';
import { StockTransferModal } from '@/components/stock-transfer-modal';
import { ProductTableHeader, ProductTableRow, type SortDirection, type SortField } from '@/components/product-table-row';
import { ProductTile } from '@/components/product-tile';
import { useAuth } from '@/hooks/use-auth';
import type { CsvColumn } from '@/lib/csv';
import { hasMultipleLocations } from '@/lib/location-selection';
import { createProduct, listProducts, setLocationStock, updateProduct } from '@/lib/products';
import { PRODUCTS_EXAMPLE_ROW, PRODUCTS_TEMPLATE_COLUMNS, runProductsImport } from '@/lib/products-import';
import type { Product } from '@/types/models';

const PRODUCT_EXPORT_COLUMNS: CsvColumn<Product>[] = [
  { header: 'Name', value: (p) => p.name },
  { header: 'SKU', value: (p) => p.sku ?? '' },
  { header: 'Barcode', value: (p) => p.barcode ?? '' },
  { header: 'Brand', value: (p) => p.brand ?? '' },
  { header: 'Category', value: (p) => p.category ?? '' },
  { header: 'Tags', value: (p) => p.tags.join('; ') },
  { header: 'Supplier', value: (p) => p.supplierName ?? '' },
  { header: 'Cost', value: (p) => (p.costCents != null ? (p.costCents / 100).toFixed(2) : '') },
  { header: 'Price', value: (p) => (p.priceCents / 100).toFixed(2) },
  { header: 'Stock', value: (p) => String(p.stock) },
  { header: 'Reorder Level', value: (p) => (p.reorderLevel != null ? String(p.reorderLevel) : '') },
  { header: 'Shelf Number', value: (p) => p.shelfNumber ?? '' },
  { header: 'Expiry Date', value: (p) => p.expiryDate ?? '' },
  { header: 'Batch Number', value: (p) => p.batchNumber ?? '' },
];

export default function InventoryScreen() {
  const { shop, can, locations, activeLocation } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < 860;
  // `inventory.view` alone is a read-only view of the catalog (the seeded
  // Cashier role's scope) — the add button, the row stock steppers, and the
  // edit modals all need `inventory.edit`, which is what the products write
  // policies check too.
  const canEdit = can('inventory.edit');
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  // null = the shop-wide rollup, which is what this screen has always shown.
  // The picker only appears once there is a second branch.
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const showLocationFilter = hasMultipleLocations(locations);
  const [stockError, setStockError] = useState<string | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  const [breakdownProduct, setBreakdownProduct] = useState<Product | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    setProducts(await listProducts(shop.id, locationFilter));
    setLoading(false);
  }, [shop, locationFilter]);

  useEffect(() => { reload(); }, [reload]);

  // Stock changes go through product_location_stock, never products.stock --
  // that column is derived by trigger now, so `updateProduct({ stock })` would
  // be silently discarded (migration 20260810000000).
  //
  // Which branch gets adjusted: the one being viewed, or this device's active
  // location when viewing the combined rollup. Adjusting a rollup is
  // meaningless -- "set stock to 12" across three branches has no single right
  // answer -- so we refuse rather than guess when neither is resolved.
  const stockLocationId = locationFilter ?? activeLocation?.id ?? null;
  // Only when a store is actually selected is a direct +/- unambiguous. In the
  // combined view of a multi-store business the row shows the total and opens
  // the per-store breakdown instead.
  const showsCombinedTotal = showLocationFilter && locationFilter === null;
  const adjustStock = async (product: Product, nextStock: number) => {
    if (!stockLocationId) {
      setStockError('Pick a location before adjusting stock.');
      return;
    }
    setStockError(null);
    try {
      await setLocationStock(product.id, stockLocationId, nextStock);
      await reload();
    } catch (err) {
      setStockError(err instanceof Error ? err.message : 'Could not update stock.');
      await reload();
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = !q
      ? products
      : products.filter((p) =>
          p.name.toLowerCase().includes(q) ||
          (p.brand ?? '').toLowerCase().includes(q) ||
          (p.sku ?? '').toLowerCase().includes(q) ||
          (p.category ?? '').toLowerCase().includes(q) ||
          p.tags.some((tag) => tag.toLowerCase().includes(q))
        );
    if (!sortField) return matches;
    const dir = sortDirection === 'asc' ? 1 : -1;
    return [...matches].sort((a, b) => {
      switch (sortField) {
        case 'name': return a.name.localeCompare(b.name) * dir;
        case 'brand': return (a.brand ?? '').localeCompare(b.brand ?? '') * dir;
        case 'category': return (a.category ?? '').localeCompare(b.category ?? '') * dir;
        case 'price': return (a.priceCents - b.priceCents) * dir;
        case 'stock': return (a.stock - b.stock) * dir;
      }
    });
  }, [products, search, sortField, sortDirection]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const importConfig: ImportEntityConfig<Product> | null = shop
    ? {
        title: 'products',
        filenamePrefix: 'products',
        templateColumns: PRODUCTS_TEMPLATE_COLUMNS,
        exampleRows: [PRODUCTS_EXAMPLE_ROW],
        run: (parsed) => runProductsImport(shop.id, parsed),
      }
    : null;

  // What the LOCATION cell says for a row.
  //
  // Scoped to one store, every row is that store — the cell repeats it so a
  // printed or exported table still says which store it describes. In the
  // combined view a product can hold stock at several, so it names the ones
  // that actually carry any: "—" when none do (the product exists in the
  // catalog but is nowhere in stock), the store when only one does, and
  // "Hargeisa +2" when more do. The alternative — one row per store — would
  // triple the table for a business with three stores.
  const locationLabelFor = useCallback(
    (product: Product): string | undefined => {
      if (!showLocationFilter) return undefined;
      if (locationFilter) return locations.find((l) => l.id === locationFilter)?.name ?? '—';
      const holding = (product.locationStock ?? []).filter((entry) => entry.stock > 0);
      if (holding.length === 0) return '—';
      const first = locations.find((l) => l.id === holding[0].locationId)?.name ?? '—';
      return holding.length === 1 ? first : `${first} +${holding.length - 1}`;
    },
    [showLocationFilter, locationFilter, locations]
  );

  const defaultLowStockLevel = shop?.defaultLowStockLevel ?? 5;
  const expiryWarningLeadDays = shop?.expiryTrackingEnabled ? shop.expiryWarningLeadDays : undefined;
  const needsAttention = products.filter((p) => p.stock <= (p.reorderLevel ?? defaultLowStockLevel)).length;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Inventory</Text>
            <Text style={styles.subtitle}>{products.length} products · {needsAttention} need attention</Text>
          </View>
          <View style={styles.headerActions}>
            <StoreDropdown value={locationFilter} onChange={setLocationFilter} />
            <ExportMenu rows={filtered} columns={PRODUCT_EXPORT_COLUMNS} title="Inventory" subtitle={`${filtered.length} products`} filenamePrefix="inventory" />
            {/* Only with somewhere to move stock TO — a one-store shop has no
                transfer to make, and the button would be a dead end. */}
            {canEdit && showLocationFilter && (
              <Pressable onPress={() => setShowTransfer(true)} style={styles.importButton}>
                <Text style={styles.importButtonText}>Move stock</Text>
              </Pressable>
            )}
            {canEdit && (
              <Pressable onPress={() => setShowImportModal(true)} style={styles.importButton}>
                <Text style={styles.importButtonText}>Import</Text>
              </Pressable>
            )}
            {canEdit && (
              <Pressable onPress={() => setShowAddModal(true)} style={styles.addButton}>
                <Text style={styles.addButtonText}>+ Add product</Text>
              </Pressable>
            )}
          </View>
        </View>
        <TextInput value={search} onChangeText={setSearch} placeholder="Search by name, brand, SKU, category, or tag" placeholderTextColor="#999999" style={styles.search} />
        {stockError && <Text style={styles.stockError}>{stockError}</Text>}
        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>No products yet. Add your first one above.</Text>
        ) : (
          <Card style={styles.list}>
            {compact ? (
              filtered.map((product) => (
                <ProductTile
                  key={product.id}
                  product={product}
                  onEdit={canEdit ? () => setEditingProduct(product) : undefined}
                  onStockChange={canEdit && !showsCombinedTotal ? (next) => adjustStock(product, next) : undefined}
                  onOpenBreakdown={canEdit && showsCombinedTotal ? () => setBreakdownProduct(product) : undefined}
                  defaultLowStockLevel={defaultLowStockLevel}
                  expiryWarningLeadDays={expiryWarningLeadDays}
                />
              ))
            ) : (
              <>
                <ProductTableHeader sortField={sortField} sortDirection={sortDirection} onSort={toggleSort} showLocation={showLocationFilter} />
                {filtered.map((product) => (
                  <ProductTableRow
                    key={product.id}
                    product={product}
                    onEdit={canEdit ? () => setEditingProduct(product) : undefined}
                    onStockChange={canEdit && !showsCombinedTotal ? (next) => adjustStock(product, next) : undefined}
                    onOpenBreakdown={canEdit && showsCombinedTotal ? () => setBreakdownProduct(product) : undefined}
                    defaultLowStockLevel={defaultLowStockLevel}
                    expiryWarningLeadDays={expiryWarningLeadDays}
                    locationLabel={locationLabelFor(product)}
                  />
                ))}
              </>
            )}
          </Card>
        )}
      </ScrollView>

      {shop && canEdit && (
        <ProductModal
          visible={showAddModal}
          onClose={() => setShowAddModal(false)}
          shopId={shop.id}
          defaultLocationId={stockLocationId}
          onSubmit={async (input, locationId) => { await createProduct(shop.id, input, locationId ?? stockLocationId); await reload(); }}
        />
      )}
      {shop && canEdit && (
        <ProductModal
          visible={editingProduct !== null}
          onClose={() => setEditingProduct(null)}
          shopId={shop.id}
          initial={editingProduct ?? undefined}
          onSubmit={async (input, locationId) => { if (editingProduct) await updateProduct(editingProduct.id, input, locationId ?? stockLocationId); await reload(); }}
          onDeleted={reload}
        />
      )}
      {importConfig && (
        <CsvImportModal visible={showImportModal} onClose={() => setShowImportModal(false)} config={importConfig} onImported={reload} />
      )}
      {breakdownProduct && (
        <StockByStoreModal
          key={breakdownProduct.id}
          product={breakdownProduct}
          onClose={() => setBreakdownProduct(null)}
          onChanged={reload}
        />
      )}
      {shop && canEdit && (
        <StockTransferModal
          visible={showTransfer}
          shopId={shop.id}
          onClose={() => setShowTransfer(false)}
          onDone={reload}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 42 },
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: '#999999', fontSize: 12, marginTop: 3 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  importButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  importButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 13, marginTop: 18, marginBottom: 18, color: '#111111' },
  stockError: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 12 },
  list: { overflow: 'hidden' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
});
