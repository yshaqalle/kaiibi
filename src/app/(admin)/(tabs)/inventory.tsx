import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BarcodeScannerModal } from '@/components/barcode-scanner-modal';
import { Card } from '@/components/card';
import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { ExportMenu } from '@/components/export-menu';
import { ProductModal } from '@/components/product-modal';
import { StoreDropdown } from '@/components/store-dropdown';
import { StockByStoreModal } from '@/components/stock-by-store-modal';
import { StockTransferModal } from '@/components/stock-transfer-modal';
import { WedgeSink } from '@/components/wedge-sink';
import { ProductTableHeader, ProductTableRow, type SortDirection, type SortField } from '@/components/product-table-row';
import { ProductTile } from '@/components/product-tile';
import { ScanFeedbackBanner } from '@/components/scan-feedback-banner';
import { ScanResultBar } from '@/components/scan-result-bar';
import { useAuth } from '@/hooks/use-auth';
import { useBarcodeWedge } from '@/hooks/use-barcode-wedge';
import { useScannerSettings } from '@/hooks/use-scanner-settings';
import { barcodeCandidates, looksLikeBarcode, resolveBarcode, type ScanFeedback } from '@/lib/barcode';
import type { CsvColumn } from '@/lib/csv';
import { hasMultipleLocations } from '@/lib/location-selection';
import { createProduct, findProductsByCode, listProducts, setLocationStock, updateProduct } from '@/lib/products';
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

// Which slice of the list is showing. 'expiring' means "has an expiry date at
// all" rather than "expires soon": the Dashboard's row already narrows to the
// shop's warning window, and a second, different definition of "soon" living
// here is how the two screens start disagreeing.
type StockFilter = 'all' | 'low' | 'expiring';

export default function InventoryScreen() {
  const { shop, can, locations, activeLocation, limitFor, usageOf } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < 860;
  // `inventory.view` alone is a read-only view of the catalog (the seeded
  // Cashier role's scope) — the add button, the row stock steppers, and the
  // edit modals all need `inventory.edit`, which is what the products write
  // policies check too.
  const canEdit = can('inventory.edit');
  // The second gate, orthogonal to the permission above: `canEdit` asks whether
  // this USER may add products, this asks whether the SHOP's plan still has room
  // for one. Both must pass.
  const productLimit = limitFor('products');
  const atProductLimit = productLimit != null && usageOf('products') >= productLimit;
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
  // Set by a link that already knows what it wants -- the Dashboard's
  // "5 products low on stock" row lands here rather than on the full list,
  // where the reader would have to find those five again.
  //
  // Read once as the INITIAL value rather than tracked: the chips below are
  // the control after arrival, and re-syncing to a stale URL would fight
  // whoever is using them. Same shape as login.tsx's `next` param, the only
  // other place this app reads a search param.
  const { filter: filterParam } = useLocalSearchParams<{ filter?: string }>();
  const [stockFilter, setStockFilter] = useState<StockFilter>(
    filterParam === 'low' || filterParam === 'expiring' ? filterParam : 'all'
  );

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

  // The product the last scan landed on, pinned above the list so a `+1` acts
  // on something named rather than on whichever row the filter happens to leave
  // at the top.
  const [pinnedProduct, setPinnedProduct] = useState<Product | null>(null);
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  // A code that resolved to nothing and that this user is allowed to turn into
  // a product. Null both when there's no such code and when they can't.
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const scanner = useScannerSettings();

  // Not wrapped in useCallback: `useBarcodeWedge` keeps it in a ref, so its
  // identity is irrelevant, and the React Compiler handles the rest.
  const handleScannedCode = async (raw: string) => {
    const resolution = resolveBarcode(products, raw);
    if (resolution.status === 'match') {
      // Filtering the list to the code as well as pinning the result keeps the
      // two views agreeing about what was just scanned.
      setSearch(resolution.product.barcode ?? resolution.product.sku ?? raw.trim());
      setPinnedProduct(resolution.product);
      setScanFeedback({ tone: 'ok', message: `${resolution.product.name} — ${resolution.product.stock} in stock` });
      return true;
    }
    if (resolution.status === 'ambiguous') {
      setSearch(raw.trim());
      setPinnedProduct(null);
      setScanFeedback({ tone: 'warn', message: `${resolution.products.length} products share this code — pick the right one below` });
      return true;
    }

    // Unlike POS, an unknown code here is often a product that exists but isn't
    // carried at the filtered store, so the server lookup is worth the trip.
    if (shop) {
      try {
        const found = await findProductsByCode(shop.id, barcodeCandidates(resolution.code));
        if (found.length === 1) {
          setSearch(found[0].barcode ?? found[0].sku ?? raw.trim());
          setPinnedProduct(found[0]);
          setScanFeedback({ tone: 'warn', message: `${found[0].name} isn't carried at this store` });
          return true;
        }
      } catch {
        // Fall through to the unknown message.
      }
    }
    setPinnedProduct(null);
    // Offered only when all three gates pass -- the permission, the plan's
    // product cap, and (implicitly) the inventory module, since the trigger
    // would refuse the insert anyway. Better to say why now than to let someone
    // fill in a whole form the database will reject.
    const canCreate = canEdit && !atProductLimit;
    setUnknownCode(canCreate ? resolution.code : null);
    setScanFeedback({
      tone: 'error',
      message: atProductLimit
        ? `No product with code ${resolution.code}. Your plan is at its product limit — remove one, or upgrade, before adding it.`
        : `No product with code ${resolution.code}`,
    });
    return false;
  };

  const handleSearchSubmit = async () => {
    const raw = search.trim();
    if (!raw || !scanner.resolveCodes) return;
    // Typing a product name and pressing Enter is a search, not a failed scan.
    if (resolveBarcode(products, raw).status === 'not-found' && !looksLikeBarcode(raw)) return;
    const handled = await handleScannedCode(raw);
    // Unlike POS the text is kept on a hit: it IS the filter showing the result.
    // A wedge's next scan replaces it wholesale, so nothing concatenates.
    if (!handled) setPinnedProduct(null);
  };

  // Off unless this store reports a wedge scanner, and off whenever a modal
  // owns the keyboard.
  useBarcodeWedge({
    enabled: scanner.hardware && !showAddModal && editingProduct === null && !showImportModal && !scannerOpen,
    onScan: handleScannedCode,
  });

  useEffect(() => {
    if (!scanFeedback) return;
    const timer = setTimeout(() => setScanFeedback(null), 4000);
    return () => clearTimeout(timer);
  }, [scanFeedback]);

  // Derived, not synced by an effect. `adjustStock` reloads the whole list, so
  // the stored copy holds the count from before the adjustment -- pressing +1
  // twice would send the same number twice and appear to do nothing the second
  // time. Reading through `products` on every render means the bar can never
  // show a stale count.
  //
  // Falls back to the stored copy when the product isn't in the list at all,
  // which is the "scanned something this store doesn't carry" case -- there the
  // stored copy is the only thing we have, and +1 is how it starts being
  // carried here.
  const scannedProduct = pinnedProduct
    ? products.find((p) => p.id === pinnedProduct.id) ?? pinnedProduct
    : null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // The stock filter runs FIRST so the search box narrows within it rather
    // than escaping it -- "rice" while filtered to low stock should mean
    // "low-stock rice", not "every rice".
    const scoped =
      stockFilter === 'low'
        ? products.filter((p) => p.stock <= (p.reorderLevel ?? shop?.defaultLowStockLevel ?? 5))
        : stockFilter === 'expiring'
          ? products.filter((p) => p.expiryDate !== null)
          : products;
    const matches = !q
      ? scoped
      : scoped.filter((p) =>
          p.name.toLowerCase().includes(q) ||
          (p.brand ?? '').toLowerCase().includes(q) ||
          (p.sku ?? '').toLowerCase().includes(q) ||
          (p.barcode ?? '').toLowerCase().includes(q) ||
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
  }, [products, search, sortField, sortDirection, stockFilter, shop?.defaultLowStockLevel]);

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
        // Headroom is read at import time rather than captured on render, so a
        // long-open screen doesn't import against a stale allowance.
        run: (parsed) =>
          runProductsImport(shop.id, parsed, {
            headroom: productLimit == null ? null : Math.max(0, productLimit - usageOf('products')),
          }),
      }
    : null;

  // What the LOCATION cell says for a row.
  //
  // Scoped to one store, every row is that store — the cell repeats it so a
  // printed or exported table still says which store it describes.
  //
  // In the combined view a product can be carried at several. One store gets
  // named; more than one gets a COUNT, tappable to see which. Naming one and
  // appending "+2" implied the named store mattered more, and made the cell a
  // different length on every row; a count says plainly that there is a set,
  // and the names are one tap away in the breakdown that was already there.
  //
  // Counted by rows CARRIED, not rows in stock — a store that stocks an item
  // and has run out still stocks it, which is the same distinction the list
  // filter makes.
  const locationLabelFor = useCallback(
    (product: Product): { text: string; multiple: boolean } | undefined => {
      if (!showLocationFilter) return undefined;
      if (locationFilter) {
        return { text: locations.find((l) => l.id === locationFilter)?.name ?? '—', multiple: false };
      }
      const carried = product.locationStock ?? [];
      if (carried.length === 0) return { text: '—', multiple: false };
      if (carried.length === 1) {
        return { text: locations.find((l) => l.id === carried[0].locationId)?.name ?? '—', multiple: false };
      }
      return { text: `${carried.length} stores`, multiple: true };
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
            <Text style={styles.subtitle}>
              {stockFilter === 'all'
                ? `${products.length} products · ${needsAttention} need attention`
                : `${filtered.length} of ${products.length} products`}
            </Text>
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
              <Pressable
                onPress={() => setShowAddModal(true)}
                disabled={atProductLimit}
                style={[styles.addButton, atProductLimit && styles.addButtonDisabled]}
              >
                <Text style={[styles.addButtonText, atProductLimit && styles.addButtonTextDisabled]}>+ Add product</Text>
              </Pressable>
            )}
          </View>
        </View>
        {/* Stated where the button is, not after a failed save: the shop needs
            to know the cap exists before deciding what to do about it. The
            database trigger remains the real gate. */}
        {canEdit && atProductLimit && (
          <Text style={styles.limitNote}>
            You&apos;ve reached {productLimit?.toLocaleString()} products on your plan. Remove one, or upgrade under
            Settings → Plan and billing. Nothing you already have is affected.
          </Text>
        )}
        {/* The scan button belongs here, not among the header actions. What a
            scan does on this screen is FIND a product — it fills the search box
            and filters the list — so it reads as a way to search, not as a
            sibling of Export and Import. Same placement as the register, so the
            control means the same thing in both places. */}
        {/* Always rendered, never only-when-filtered: someone who arrives on a
            deep link has to be able to SEE that the list is narrowed and get
            back out of it. A filtered list that looks like the whole list is
            worse than no link at all. */}
        <View style={styles.stockFilterRow}>
          {(['all', 'low', 'expiring'] as StockFilter[])
            .filter((key) => key !== 'expiring' || shop?.expiryTrackingEnabled)
            .map((key) => (
              <Pressable
                key={key}
                onPress={() => setStockFilter(key)}
                style={[styles.stockChip, stockFilter === key && styles.stockChipActive]}
              >
                <Text style={[styles.stockChipText, stockFilter === key && styles.stockChipTextActive]}>
                  {key === 'all' ? 'All' : key === 'low' ? `Low stock ${needsAttention}` : 'Has expiry'}
                </Text>
              </Pressable>
            ))}
        </View>

        <View style={styles.searchWrap}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            // The full list of searchable fields doesn't fit a phone -- it
            // truncated mid-word at "barcod...", which reads as a bug rather
            // than as a hint. The narrow form still says the two things that
            // matter: you can search, and you can scan.
            placeholder={compact ? 'Search or scan a product' : 'Search or scan — name, brand, SKU, barcode, category, or tag'}
            placeholderTextColor="#999999"
            style={[styles.search, scanner.camera && styles.searchWithScan]}
            onSubmitEditing={handleSearchSubmit}
            blurOnSubmit={false}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {/* Not gated on `canEdit` or the plan cap: looking a product up by
              scanning it is a read, which `inventory.view` already covers, and
              it stays useful to a shop that's out of room to add more. */}
          {scanner.camera && (
            <Pressable onPress={() => setScannerOpen(true)} style={styles.scanInSearch} accessibilityLabel="Scan a barcode">
              <Text style={styles.scanInSearchText}>⛶</Text>
            </Pressable>
          )}
        </View>
        <ScanFeedbackBanner feedback={scanFeedback} />
        {unknownCode && (
          <Pressable onPress={() => setShowAddModal(true)} style={styles.addFromScan}>
            <Text style={styles.addFromScanText}>+ Add a product with barcode {unknownCode}</Text>
          </Pressable>
        )}
        {scannedProduct && (
          <ScanResultBar
            product={scannedProduct}
            locationLabel={locationLabelFor(scannedProduct)?.text}
            onAdjust={canEdit ? (delta) => adjustStock(scannedProduct, Math.max(0, scannedProduct.stock + delta)) : undefined}
            onEdit={canEdit ? () => setEditingProduct(scannedProduct) : undefined}
            onDismiss={() => setPinnedProduct(null)}
          />
        )}
        {stockError && <Text style={styles.stockError}>{stockError}</Text>}
        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>
            {locationFilter
              ? // A store carries a product once it has a stock row there, so an
                // empty list here is a real answer, not a missing filter. It
                // also has to say how to change that, since the routes in are
                // all somewhere else.
                `${locations.find((l) => l.id === locationFilter)?.name ?? 'This store'} doesn't carry anything yet. Use Move stock to send some here, or open a product from All stores and set its count for this store.`
              : 'No products yet. Add your first one above.'}
          </Text>
        ) : (
          <Card style={styles.list}>
            {compact ? (
              filtered.map((product) => (
                <ProductTile
                  key={product.id}
                  product={product}
                  onEdit={canEdit ? () => setEditingProduct(product) : undefined}
                  onStockChange={canEdit && !showsCombinedTotal ? (next) => adjustStock(product, next) : undefined}
                  onOpenBreakdown={showsCombinedTotal ? () => setBreakdownProduct(product) : undefined}
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
                    onOpenBreakdown={showsCombinedTotal ? () => setBreakdownProduct(product) : undefined}
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
          onClose={() => { setShowAddModal(false); setUnknownCode(null); }}
          shopId={shop.id}
          defaultLocationId={stockLocationId}
          // Prefilled when this was opened from a scan that matched nothing, so
          // the code doesn't have to be read off the label and typed back in.
          defaults={unknownCode ? { barcode: unknownCode } : undefined}
          onSubmit={async (input, locationId) => {
            await createProduct(shop.id, input, locationId ?? stockLocationId);
            setUnknownCode(null);
            setScanFeedback(null);
            await reload();
          }}
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
          canEdit={canEdit}
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
      {scanner.hardware && !scannerOpen && !showAddModal && editingProduct === null && !showImportModal && !showTransfer && (
        <WedgeSink onScan={handleScannedCode} />
      )}
      {/* Single, unlike POS: a scan here answers one question — "which product
          is this, and what do I have?" — and the result bar behind the modal is
          the answer, so staying in the camera would hide it. */}
      <BarcodeScannerModal
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={handleScannedCode}
        mode="single"
        title="Scan to find a product"
        hint="Point the camera at a barcode to look it up."
        feedback={scanFeedback}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  stockFilterRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
  stockChip: { borderWidth: 1, borderColor: '#ECECEC', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  stockChipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  stockChipText: { fontSize: 12, fontWeight: '700', color: '#666666' },
  stockChipTextActive: { color: '#FFFFFF' },
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 42 },
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: '#999999', fontSize: 12, marginTop: 3 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  addButtonDisabled: { backgroundColor: '#E5E5E5' },
  addButtonTextDisabled: { color: '#999999' },
  limitNote: { color: '#9A6412', fontSize: 12, lineHeight: 18, marginBottom: 12 },
  importButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  importButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  searchWrap: { position: 'relative', justifyContent: 'center' },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 13, marginTop: 18, marginBottom: 18, color: '#111111' },
  // Only when the button is actually there, so a store without scanning keeps
  // the full-width field.
  searchWithScan: { paddingRight: 44 },
  scanInSearch: { position: 'absolute', right: 5, height: 32, width: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  scanInSearchText: { fontSize: 15, color: '#111111' },
  stockError: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 12 },
  addFromScan: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 11, marginBottom: 14 },
  addFromScanText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  list: { overflow: 'hidden' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
});
