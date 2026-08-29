import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BarcodeScannerModal } from '@/components/barcode-scanner-modal';
import { Card } from '@/components/card';
import { CategoryChip } from '@/components/category-chip';
import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { ExportMenu } from '@/components/export-menu';
import { withModuleWall } from '@/components/module-wall';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import { useInventorySessionField } from '@/hooks/use-inventory-session';
import { ProductModal } from '@/components/product-modal';
import { StoreDropdown } from '@/components/store-dropdown';
import { StockActionsSheet, type StockAction } from '@/components/stock-actions-sheet';
import { StockByStoreModal } from '@/components/stock-by-store-modal';
import { StockCountModal } from '@/components/stock-count-modal';
import { StockRestockModal } from '@/components/stock-restock-modal';
import { StockTransferModal } from '@/components/stock-transfer-modal';
import { useStagedSheet } from '@/components/use-staged-sheet';
import { TillKeyboardNotice } from '@/components/till-keyboard-notice';
import { WedgeSink } from '@/components/wedge-sink';
import { ProductTableHeader, ProductTableRow, type SortDirection, type SortField } from '@/components/product-table-row';
import { ProductTile } from '@/components/product-tile';
import { ScanFeedbackBanner } from '@/components/scan-feedback-banner';
import { ScanResultBar } from '@/components/scan-result-bar';
import { SearchKeypad } from '@/components/search-keypad';
import { SearchRow, useSearchKeypadState } from '@/components/search-row';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useBarcodeWedge, useWedgeSinkFallback } from '@/hooks/use-barcode-wedge';
import { useScannerSettings } from '@/hooks/use-scanner-settings';
import { useKeypadProven } from '@/lib/keypad-proof';
import { barcodeCandidates, looksLikeBarcode, resolveBarcode, type ScanFeedback } from '@/lib/barcode';
import { formatCompactCents } from '@/lib/currency';
import type { CsvColumn } from '@/lib/csv';
import { hasMultipleLocations } from '@/lib/location-selection';
import { isUncosted } from '@/lib/product-costing';
import { createProduct, findProductsByCode, listProducts, setLocationStock, updateProduct } from '@/lib/products';
import { PRODUCTS_EXAMPLE_ROWS, PRODUCTS_TEMPLATE_COLUMNS, productImportHatches, runProductsImport } from '@/lib/products-import';
import type { Product } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';

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
  // Named for the toggle that sets it (product-form.tsx), not for the column
  // underneath -- a shop reconciling a spreadsheet against its Storefront page
  // is looking for the switch it flipped. Yes/No rather than true/false: this
  // file is read in a spreadsheet by a shopkeeper, not by a parser.
  { header: 'Sell Online', value: (p) => (p.isListedOnline ? 'Yes' : 'No') },
];

// Which slice of the list is showing. 'expiring' means "has an expiry date at
// all" rather than "expires soon": the Dashboard's row already narrows to the
// shop's warning window, and a second, different definition of "soon" living
// here is how the two screens start disagreeing.
//
// 'online'/'notonline' are the storefront pair. Both directions get a chip
// because they answer different questions: 'online' is "what is on my page",
// which is how a shop checks its storefront, and 'notonline' is "what is not
// yet", which is the only actionable list for a shop whose page will not
// publish. The storefront's `no_products` blocker deep-links to the latter.
//
// Deliberately NOT gated on the `storefront` module: the toggle that sets
// `is_listed_online` (product-form.tsx) is shown to every shop regardless of
// plan, so a chip pair that appeared and disappeared with the plan would
// describe a field the form does not. It also keeps the deep link honest --
// entitlements load asynchronously, and a gate here would sometimes drop the
// seeded filter on the first render and silently land the shopkeeper on the
// unfiltered list, which is the failure this whole change exists to remove.
const STOCK_FILTERS = ['all', 'low', 'expiring', 'nocost', 'online', 'notonline'] as const;
type StockFilter = (typeof STOCK_FILTERS)[number];

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

function InventoryScreen() {
  const { shop, can, locations, activeLocation, limitFor, usageOf } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < 860;
  // `inventory.view` alone is a read-only view of the catalog (the seeded
  // Cashier role's scope) — the add button, the row stock steppers, and the
  // edit modals all need `inventory.edit`, which is what the products write
  // policies check too.
  const canEdit = can('inventory.edit');
  // Nested under canEdit and checked separately. Both were granted to every
  // role that already held inventory.edit when the split shipped, so these are
  // false only where a shop has deliberately turned one off -- and each is
  // re-checked by the database in the RPC behind it, because the sheet must not
  // be the only thing standing between a cashier and a write-off.
  const canCount = canEdit && can('inventory.count');
  const canTransfer = canEdit && can('inventory.transfer');
  // The second gate, orthogonal to the permission above: `canEdit` asks whether
  // this USER may add products, this asks whether the SHOP's plan still has room
  // for one. Both must pass.
  const productLimit = limitFor('products');
  const atProductLimit = productLimit != null && usageOf('products') >= productLimit;
  const [products, setProducts] = useState<Product[]>([]);
  // Held in the session store rather than in this component: `<Slot />` unmounts
  // the whole screen on a tab switch AND on crossing the web width breakpoint,
  // and a scan's answer must not evaporate either time. See use-inventory-session.
  const [search, setSearch] = useInventorySessionField('search');
  // Tracks the FIRST fetch, not every fetch. `reload()` runs again after each
  // stock adjustment, and swapping the rendered rows for a placeholder on those
  // collapsed the scroll content to a few pixels -- the platform then clamps the
  // scroll offset to fit, so the list came back at the top and the cashier lost
  // their place after every single +/-. Same flag, same reason, as the
  // accounting tabs and people.tsx.
  const [loaded, setLoaded] = useState(false);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  // null = the shop-wide rollup, which is what this screen has always shown.
  // The picker only appears once there is a second branch.
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const showLocationFilter = hasMultipleLocations(locations);
  // The import sheet's two escape hatches, each handing over to another sheet.
  // `elsewhere` (see `productImportHatches`) opens the restock sheet through
  // `restockFromImport` and, for a multi-store shop only, the transfer sheet
  // through `moveFromImport` -- because the rejection it answers cannot tell
  // "more arrived" from "put these at the other branch", so it offers both.
  // The Stock door's own Restock and Move go through `actionFromStock`, not
  // these; these are only the handover from inside Import.
  //
  // Held by useStagedSheet rather than plain state because each is a sheet
  // opened from inside a sheet, which iOS drops without a word. Both are wired
  // identically -- into `showRestock`/`transferOpen`, `CsvImportModal`'s
  // suppression and `onDismissed`, and the target sheet's close handler -- and
  // a hatch missing any one of those is a button that does nothing on iOS
  // alone, where nothing is logged when it happens.
  const moveFromImport = useStagedSheet<true>();
  const restockFromImport = useStagedSheet<true>();
  // Where a newly imported product's opening stock actually lands: the
  // opening-stock trigger picks `order by is_primary desc, created_at asc`
  // (migration 20260810000000), so this mirrors that rather than guessing.
  const primaryLocationName =
    locations.find((location) => location.isPrimary)?.name ?? locations[0]?.name ?? 'your main store';
  const [stockError, setStockError] = useState<string | null>(null);
  const [showStockActions, setShowStockActions] = useState(false);
  // Two staged handovers, not one. On a phone the chain is More → Stock →
  // Restock, which is three sheets deep, and iOS silently drops the third --
  // the exact bug use-staged-sheet was written for. Each hop stages its own.
  const stockFromMore = useStagedSheet<true>();
  const actionFromStock = useStagedSheet<StockAction>();
  // Derived, not state promoted by an effect. Which sheet the door handed over
  // to IS `actionFromStock.value` -- copying it into a second `useState` inside
  // a `useEffect` would be a second copy of the same fact that can disagree
  // with the first, and the linter rejects the setState-in-effect that copying
  // needs. Read straight, exactly as StockTransferModal already reads
  // `moveFromImport.value` below.
  //
  // Each of these is named once because two or three places need the same
  // answer -- the sheet's own `visible`, and the wedge-scanner stand-downs
  // below and at the foot of the file. The transfer sheet's comment records
  // what happens when a stand-down and a `visible` drift apart: the sheet is up
  // and the screen behind it is still adjusting stock on every scan.
  const showRestock = restockFromImport.value !== null || actionFromStock.value === 'restock';
  const showCount = actionFromStock.value === 'count';
  // `|| actionFromStock.presenterSuppressed` closes a gap, not a typo: between
  // `onPick` and the promotion, `pending` holds the next action but `value` is
  // still null, so `showRestock`/`transferOpen`/`importOpen` all read false and
  // the door itself is already closed -- the wedge below would read every one
  // of those as false and switch back on while a modal is mid-animation.
  // `presenterSuppressed` stays true for that whole gap, and the door's own
  // `visible` (below) already ANDs its negation in, so folding it into
  // `stockDoorOpen` cannot re-present the door -- it only keeps the wedge (and
  // the sink fallback) standing down through the handover.
  const stockDoorOpen = showStockActions || stockFromMore.value !== null || actionFromStock.presenterSuppressed;
  const transferOpen = moveFromImport.value !== null || actionFromStock.value === 'move';
  const importOpen = actionFromStock.value === 'import';
  // Phone only. The store filter, Export and Stock live behind one pill on the
  // title row rather than wrapping to a second and third row.
  const [showMore, setShowMore] = useState(false);
  const [breakdownProduct, setBreakdownProduct] = useState<Product | null>(null);
  // Set by a link that already knows what it wants -- the Dashboard's
  // "5 products low on stock" row lands here rather than on the full list,
  // where the reader would have to find those five again, and the Storefront's
  // "Go to Inventory →" lands on the products that are not on the page yet.
  //
  // Read once as the INITIAL value rather than tracked: the chips below are
  // the control after arrival, and re-syncing to a stale URL would fight
  // whoever is using them. Same shape as login.tsx's `next` param, the only
  // other place this app reads a search param.
  //
  // Checked against STOCK_FILTERS rather than an inline chain of equalities so
  // adding a filter cannot leave its deep link silently falling through to
  // 'all'. An unrecognised value still means the whole list: a link nobody
  // defined must not narrow anything.
  const { filter: filterParam } = useLocalSearchParams<{ filter?: string }>();
  const [stockFilter, setStockFilter] = useState<StockFilter>(() =>
    STOCK_FILTERS.includes(filterParam as StockFilter) ? (filterParam as StockFilter) : 'all'
  );

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      setProducts(await listProducts(shop.id, locationFilter));
    } finally {
      // In a `finally` so a failed fetch still clears the placeholder rather
      // than leaving the screen reading "Loading…" for the rest of the session.
      setLoaded(true);
    }
  }, [shop, locationFilter]);

  useEffect(() => { reload(); }, [reload]);
  // Coming back to this screen on a phone, where the tab shell never unmounted
  // it, so its data is as old as the last time it was looked at.
  useRefreshOnFocus(reload);
  // The manual counterpart: the only way to pick up another till's sale,
  // since nothing is pushed to this device.
  const pullToRefresh = usePullToRefresh(reload);

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
  const [pinnedProduct, setPinnedProduct] = useInventorySessionField('pinnedProduct');
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  // A code that resolved to nothing and that this user is allowed to turn into
  // a product. Null both when there's no such code and when they can't.
  const [unknownCode, setUnknownCode] = useInventorySessionField('unknownCode');
  const scanner = useScannerSettings();
  const { keypadOpen, setKeypadOpen } = useSearchKeypadState(scanner.onScreenKeypad);
  // Old binaries only. See `useWedgeSinkFallback`.
  const sinkFallback = useWedgeSinkFallback();
  // The old keypad stands down only once the new dock has been seen working on
  // this device -- never on a claim that it could.
  const universalKeypad = useKeypadProven();
  const scrollRef = useRef<ScrollView>(null);
  // Content-relative y of the search row, captured on layout so opening the
  // keypad can bring the row into view — the dock shrinks the viewport, and a
  // row tapped near the bottom would otherwise end up under the dock.
  const searchRowY = useRef(0);

  // Not wrapped in useCallback: `useBarcodeWedge` keeps it in a ref, so its
  // identity is irrelevant, and the React Compiler handles the rest.
  const handleScannedCode = async (raw: string) => {
    // The last scan's offer to create a product is about the last scan. Left
    // standing it invites someone to add a product under a barcode they are no
    // longer holding -- and it is the ONE control on the screen that survives
    // its own result banner, so it reads as current long after it isn't.
    setUnknownCode(null);

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

  // `submitted` rather than `search`: on the scan path the row has just
  // replaced the field, and this runs in the same tick as that replacement.
  const handleSearchSubmit = async (submitted: string) => {
    const raw = submitted.trim();
    if (!raw || !scanner.resolveCodes) return;
    // Typing a product name and pressing Enter is a search, not a failed scan.
    if (resolveBarcode(products, raw).status === 'not-found' && !looksLikeBarcode(raw)) return;
    const handled = await handleScannedCode(raw);
    // Unlike POS the text is kept on a hit: it IS the filter showing the result.
    // The next scan replaces it wholesale rather than extending it -- see
    // `stepFieldBurst`, which is what makes keeping it safe.
    if (!handled) setPinnedProduct(null);
  };

  // Off unless this store reports a wedge scanner, and off whenever a modal
  // owns the keyboard.
  useBarcodeWedge({
    // The transfer and restock sheets are both excluded, and on web that
    // exclusion is now load-bearing rather than merely tidy: each of them runs
    // a wedge of its own to build its basket (see stock-transfer-modal.tsx and
    // stock-restock-modal.tsx, where scanning is gated to web because a React
    // Native Modal on Android is a Dialog whose window the key capture never
    // sees). One scan must never be read BOTH as a line in that basket and as
    // an adjustment to the product behind it. Written as the same conditions
    // those sheets' `visible` uses -- `transferOpen` and `importOpen` are
    // derived from `moveFromImport.value` and `actionFromStock.value`, which
    // already cover a hand-over into either sheet, not only each sheet opened
    // directly from its own door.
    enabled:
      scanner.hardware &&
      !showAddModal &&
      editingProduct === null &&
      !importOpen &&
      !scannerOpen &&
      !showRestock &&
      !stockDoorOpen &&
      !transferOpen &&
      // The count sheet offers no scanning of its own, so unlike the other two
      // this is not about one code being read twice. It is the simpler rule the
      // app already follows: a scanner firing into the screen BEHIND an open
      // sheet adjusts a product nobody is looking at, and the count sheet is
      // the worst place for that to happen -- it would move the very number
      // being counted, out from under the person counting it.
      !showCount,
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
          : stockFilter === 'nocost'
            ? products.filter(isUncosted)
            : stockFilter === 'online'
              ? products.filter((p) => p.isListedOnline)
              : stockFilter === 'notonline'
                ? products.filter((p) => !p.isListedOnline)
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
        exampleRows: PRODUCTS_EXAMPLE_ROWS,
        // Says what this import is for, because it was being used for something
        // else: stocking a second store by re-importing the catalogue, which
        // counts the same units twice. New stock lands at the primary store
        // either way -- that is the opening-stock trigger (migration
        // 20260810000000), not a choice this screen makes -- so naming the
        // store here is the honest thing rather than offering a picker that
        // could not be honoured.
        //
        // Only what prose alone can say. This paragraph used to carry the whole
        // explanation -- "that's a Restock", "that's a Move" -- because there
        // was one button and Move had no other way to be named. The buttons
        // below now say both, so repeating them here would make the reader
        // choose between a sentence and a control that mean the same thing.
        // What stays is what no button says: who this import is for, where
        // opening stock lands, and the consequence of importing anyway.
        purpose: showLocationFilter
          ? `For adding products you don't sell yet. Stock on a new product starts at ${primaryLocationName}. Importing something you already carry would count the same units twice.`
          : `For adding products you don't sell yet. Importing something you already carry would count the same units twice.`,
        // Both doors, not one. The rejection fires on "you already carry this
        // product", which is the same row whether the shop means more units
        // arriving or the same units at another branch -- so it asks rather
        // than picking. Move is withheld from a single-store shop inside
        // `productImportHatches`, which is where that gate is tested.
        //
        // Staged rather than a plain setShowRestock(true): these buttons live
        // INSIDE the import sheet, and iOS drops a modal presented while
        // another is still up -- so on a phone they would have done nothing at
        // all, silently. `fromModal` is true because the import always is one.
        elsewhere: productImportHatches({
          locations,
          canTransfer,
          onRestock: () => restockFromImport.open(true, true),
          onMove: () => moveFromImport.open(true, true),
        }),
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
  const uncostedCount = products.filter(isUncosted).length;
  // Both halves of the storefront pair, counted over the whole catalogue rather
  // than the visible list -- these label chips, and a chip that counted only
  // what the current chip is showing would read 0 for every chip but its own.
  const onlineCount = products.filter((p) => p.isListedOnline).length;
  const notOnlineCount = products.length - onlineCount;

  // Which uncosted count has been acknowledged. Holding the NUMBER rather than
  // a boolean is what lets the warning come back when the number changes --
  // dismissing it at 2 should not silence it at 9. That is exactly the shape
  // useCaveatDismissal stores, so these now survive leaving the tab instead of
  // resetting on the next mount.
  const uncostedNote = useCaveatDismissal('inventory.uncosted-products', String(uncostedCount));
  const retailNote = useCaveatDismissal('inventory.stock-at-retail', 'v1');
  // Dismissible, and keyed to WHICH sentence was read rather than to a bare
  // 'v1'. An explanation that never changes is fair to close forever — that is
  // what the hook says a 'context' signature is for — but this one has two
  // wordings, and the multi-store half is the part with real money in it. A
  // shop that reads and closes the single-store sentence, then opens a second
  // branch, has not been told that a delivery at one branch now moves the
  // other's number; changing the signature makes that a new fact and brings it
  // back exactly once.
  const costBasisNote = useCaveatDismissal(
    'inventory.stock-at-cost-basis',
    showLocationFilter ? 'multi-store-v1' : 'single-store-v1'
  );

  // What the shelf is worth, twice: at what it cost and at what it would sell
  // for. Reported as a PAIR because either alone invites the reader to supply
  // the other from imagination, and the gap between them is the margin sitting
  // in the stockroom.
  //
  // Summed over the list already in memory -- no query. Negative stock is
  // clamped: a miscount that has driven a count below zero shouldn't quietly
  // subtract from what the shop is holding.
  const stockValue = useMemo(() => {
    let costCents = 0;
    let retailCents = 0;
    for (const product of products) {
      const units = Math.max(0, product.stock);
      // An uncosted product contributes 0 here, which is exactly why the
      // caveat below has to say so -- the figure is understated, not merely
      // approximate.
      costCents += (product.costCents ?? 0) * units;
      retailCents += product.priceCents * units;
    }
    return { costCents, retailCents };
  }, [products]);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} refreshControl={pullToRefresh}>
        <View style={styles.header}>
          <View style={styles.headerTitles}>
            <Text style={styles.eyebrow}>INVENTORY</Text>
            <Text style={styles.title}>Inventory</Text>
            <Text style={styles.subtitle}>
              {stockFilter === 'all'
                ? 'What you carry, what it cost, and what is left.'
                : `${filtered.length} of ${products.length} products`}
            </Text>
          </View>
          {/* Four controls fit at desktop width. Compact keeps two -- More and
              + Add -- and folds the rest into a sheet — same split the
              Schedule tab landed on. */}
          <View style={styles.headerActions}>
            {compact ? (
              <>
                <Pressable onPress={() => setShowMore(true)} style={styles.pillButton} accessibilityLabel="More inventory actions">
                  <Text style={styles.pillButtonText}>More</Text>
                </Pressable>
                {canEdit && (
                  <Pressable
                    onPress={() => setShowAddModal(true)}
                    disabled={atProductLimit}
                    style={[styles.pillButton, styles.pillButtonSolid, atProductLimit && styles.pillButtonDisabled]}
                  >
                    <Text style={[styles.pillButtonText, styles.pillButtonTextSolid]}>+ Add</Text>
                  </Pressable>
                )}
              </>
            ) : (
              <>
                <StoreDropdown value={locationFilter} onChange={setLocationFilter} />
                <ExportMenu rows={filtered} columns={PRODUCT_EXPORT_COLUMNS} title="Inventory" subtitle={`${filtered.length} products`} filenamePrefix="inventory" />
                {/* One pill, four jobs. Move stock and Import used to sit here
                    as peers of + Add product, which put three different verbs
                    in one uniform -- and is how a shop with a delivery to
                    receive ended up in Import, counting its units twice. The
                    sheet behind this button is what tells them apart. */}
                {canEdit && (
                  <Pressable onPress={() => setShowStockActions(true)} style={[styles.pillButton, styles.pillButtonSolid]}>
                    <Text style={[styles.pillButtonText, styles.pillButtonTextSolid]}>Stock</Text>
                  </Pressable>
                )}
                {canEdit && (
                  <Pressable
                    onPress={() => setShowAddModal(true)}
                    disabled={atProductLimit}
                    style={[styles.pillButton, styles.pillButtonSolid, atProductLimit && styles.pillButtonDisabled]}
                  >
                    <Text style={[styles.pillButtonText, styles.pillButtonTextSolid]}>+ Add product</Text>
                  </Pressable>
                )}
              </>
            )}
          </View>
        </View>

        {/* One card, not a grid: four figures read as a single glance. */}
        <BentoCard title="Stock at a glance" style={styles.strip}>
          <View style={styles.metricRow}>
            <StatTile
              variant="bento"
              value={String(products.length)}
              label="Products"
              hint={showLocationFilter ? 'carried across your stores' : undefined}
            />
            <StatTile variant="bento" value={String(needsAttention)} label="Low stock" hint="at or below reorder level" />
            {/* IAS 2.36(a) requires the cost formula to be disclosed, and with
                one formula that is a constant string rather than a column.

                It said "at the latest price paid" until
                20260907000000_moving_weighted_average.sql, which was accurate
                then and is not now: receive_stock averaged the newest delivery
                into the cost instead of replacing it with it. The hint states
                the basis and the caveat below says what the basis means. */}
            <StatTile variant="bento" value={formatCompactCents(stockValue.costCents)} label="Stock at cost" hint="at weighted average cost" />
            <StatTile
              variant="bento"
              value={formatCompactCents(stockValue.retailCents)}
              label="Stock at retail"
              hint="if it all sold at list price"
            />
          </View>
        </BentoCard>

        {/* A number with a cause the reader can remove, so 'wrong' with an
            action — and the action is the filter chip already below.

            Dismissal is keyed to the COUNT, not to a boolean: closing it says
            "I know about these 2", not "never tell me about uncosted products
            again". A third one appearing is a new fact and says so. */}
        {uncostedCount > 0 && !uncostedNote.dismissed && (
          <Caveat
            tone="wrong"
            action={{ label: `Show the ${uncostedCount}`, onPress: () => setStockFilter('nocost') }}
            onDismiss={uncostedNote.dismiss}
          >
            {`${uncostedCount} product${uncostedCount === 1 ? ' has' : 's have'} no purchase cost recorded. ${
              uncostedCount === 1 ? 'It counts' : 'They count'
            } as nothing in stock at cost, so that figure is understated — and anything sold from ${
              uncostedCount === 1 ? 'it' : 'them'
            } counts as pure profit, so gross profit reads higher than it is.`}
          </Caveat>
        )}

        {/* What "Stock at cost" is actually counting, and the IAS 2.36(a)
            disclosure of which cost formula it uses. Weighted average is one
            of the two formulas IAS 2.25 permits; the other is FIFO.

            This used to say the figure valued every unit at the most recent
            price paid, which was true and was the problem — that is
            replacement cost, which the standard does not permit at all.
            20260907000000_moving_weighted_average.sql changed the arithmetic
            and this text changed with it.

            Still SHOP-WIDE, and still worth saying: products.cost_cents is one
            column per product and product_location_stock has no cost of its
            own, so a delivery to one branch moves every branch's cost. The
            average is taken against shop-wide stock precisely so that the same
            delivery cannot produce a different cost depending on where it
            landed.

            'context', not 'wrong', and deliberately no action: the figure is
            computed on a permitted basis and there is nothing a shop can do
            about it from this screen. A 'wrong' with no fix would train people
            to skip the whole family — including the uncosted one above, which
            does have a fix.

            Sits after the uncosted warning and before Stock at retail: the
            actionable one leads, then the two explanations follow their tiles
            left to right. */}
        {products.length > 0 && !costBasisNote.dismissed && (
          <Caveat tone="context" onDismiss={costBasisNote.dismiss}>
            {showLocationFilter
              ? 'Stock is valued at weighted average cost. Each delivery moves a product’s cost part of the way toward what you just paid — by how much depends on how much you already held — rather than replacing it outright. That average is one figure per product across all your stores, so a delivery to one store moves the cost everywhere.'
              : 'Stock is valued at weighted average cost. Each delivery moves a product’s cost part of the way toward what you just paid — by how much depends on how much you already held — rather than replacing it outright.'}
          </Caveat>
        )}

        {/* The number is right; it just invites a wrong reading. 'context', and
            deliberately no action — there is nothing to fix. A plain "I've read
            it" is enough to dismiss an explanation. */}
        {products.length > 0 && !retailNote.dismissed && (
          <Caveat tone="context" onDismiss={retailNote.dismiss}>
            Stock at retail is what the shelf would bring in if every unit sold at its current price — no discounts, no
            expiry, no shrinkage. A ceiling, not a forecast.
          </Caveat>
        )}
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
          {STOCK_FILTERS.filter((key) => key !== 'expiring' || shop?.expiryTrackingEnabled).map((key) => (
            <CategoryChip
              key={key}
              variant="bento"
              active={stockFilter === key}
              onPress={() => setStockFilter(key)}
              // Shown with its count even at zero, like Low stock. The comment
              // above this row argues a narrowed list that looks unnarrowed is
              // worse than no link at all -- a chip that hid itself when the
              // count was zero could neither be got out of on a deep link, nor
              // report the genuinely useful news that the count IS zero.
              //
              // "Online" / "Not online" is the word the storefront's publish
              // blocker uses ("Add at least one product marked to sell online")
              // and the word on the toggle that sets it. Short on purpose: this
              // row wraps at 390px, where the storefront walkthrough happens.
              label={
                key === 'all'
                  ? 'All'
                  : key === 'low'
                    ? `Low stock ${needsAttention}`
                    : key === 'expiring'
                      ? 'Has expiry'
                      : key === 'nocost'
                        ? `No cost ${uncostedCount}`
                        : key === 'online'
                          ? `Online ${onlineCount}`
                          : `Not online ${notOnlineCount}`
              }
            />
          ))}
        </View>

        <TillKeyboardNotice />

        <View onLayout={(e) => { searchRowY.current = e.nativeEvent.layout.y; }}>
          <SearchRow
            value={search}
            onChange={setSearch}
            onSubmit={handleSearchSubmit}
            // The full list of searchable fields doesn't fit a phone -- it
            // truncated mid-word at "barcod...", which reads as a bug rather
            // than as a hint.
            placeholder={compact ? 'Search or scan a product' : 'Search or scan — name, brand, SKU, barcode, category, or tag'}
            // Legacy binaries only. Where `TillKeypad` can type into the
            // focused field, this box is an ordinary text field like every
            // other one in the app -- the tap-to-open Pressable existed to
            // keep focus away from the invisible sink, and there is no sink
            // to protect any more. Leaving it on made the box hold focus
            // permanently, so scans landed in it as text instead of resolving.
            useKeypad={scanner.onScreenKeypad && !universalKeypad}
            showScanButton={scanner.camera}
            onScanPress={() => setScannerOpen(true)}
            keypadOpen={keypadOpen}
            onKeypadOpenChange={(open) => {
              setKeypadOpen(open);
              // Bring the row to the top of the shrunken viewport so what you
              // type is visible while you type it.
              if (open) scrollRef.current?.scrollTo({ y: Math.max(0, searchRowY.current - 12), animated: true });
            }}
          />
        </View>
        <ScanFeedbackBanner feedback={scanFeedback} />
        {/* The offer outlives its own result banner by design -- it is the one
            thing on the screen you may still want a minute after the scan. That
            is exactly why it needs a way out: clearing the search box does not
            take it with it, so without this a mis-scanned code sits here
            offering to become a product until the screen is left entirely. */}
        {unknownCode && (
          <View style={styles.addFromScan}>
            <Pressable onPress={() => setShowAddModal(true)} style={styles.addFromScanBody} accessibilityRole="button">
              <Text style={styles.addFromScanText}>+ Add a product with barcode {unknownCode}</Text>
            </Pressable>
            <Pressable
              onPress={() => setUnknownCode(null)}
              style={styles.addFromScanDismiss}
              accessibilityRole="button"
              accessibilityLabel="Dismiss add product"
              hitSlop={8}
            >
              <Text style={styles.addFromScanDismissText}>✕</Text>
            </Pressable>
          </View>
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
        {!loaded ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : filtered.length === 0 ? (
          // Boxed rather than floating on the page: an empty list is still an
          // answer, and it reads as one when it sits where the list would.
          <BentoCard>
            <Text style={styles.empty}>
            {// A filtered-to-zero list must say WHICH filter emptied it --
            // otherwise it reads as an empty shop rather than a shop that
            // happens to have nothing matching the chip it's on. Checked
            // first, and ahead of locationFilter, because it's the more
            // specific, more actionable explanation of the two.
            stockFilter === 'nocost'
              ? 'Every product has a purchase cost recorded. Uncosted sales on the Dashboard belong to products that have since been given one.'
              : stockFilter === 'low'
                ? 'Nothing is low on stock right now.'
                : stockFilter === 'expiring'
                  ? 'No products have an expiry date set.'
                  : // The state 11 of 11 production shops are in, and the one
                    // the storefront's publish blocker is about -- so this is
                    // the sentence that has to name the fix, since the fix is a
                    // toggle inside a product and nothing else on this screen
                    // points at it.
                    stockFilter === 'online'
                    ? 'No products are on your Storefront page yet. Open a product and turn on Sell online to put it there.'
                    : stockFilter === 'notonline'
                      ? 'Every product is on your Storefront page.'
                      : locationFilter
                        ? // A store carries a product once it has a stock row there, so an
                          // empty list here is a real answer, not a missing filter. It
                          // also has to say how to change that, since the routes in are
                          // all somewhere else.
                          // "Stock → Move" rather than "Move stock": the pill by
                          // that name is gone, and a route named after a button
                          // that no longer exists is worse than no route at all.
                          `${locations.find((l) => l.id === locationFilter)?.name ?? 'This store'} doesn't carry anything yet. Use Stock → Move to send some here, or open a product from All stores and set its count for this store.`
                        : 'No products yet. Add your first one above.'}
            </Text>
          </BentoCard>
        ) : (
          <Card variant="bento" style={styles.list}>
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

      {/* A flex sibling, not an overlay: the ScrollView shrinks above it, so
          the grid stays scrollable to its last row with the keypad open —
          exactly what the system keyboard does. See the dock-fix mockup. */}
      {/* The legacy path. Where the binary can type into the focused field,
          `TillKeypad` at the app root serves this box and every other one --
          rendering both would put two keyboards on screen at once. */}
      {keypadOpen && scanner.onScreenKeypad && !universalKeypad ? (
        <SearchKeypad
          value={search}
          onChange={setSearch}
          onSubmit={handleSearchSubmit}
          onClose={() => setKeypadOpen(false)}
        />
      ) : null}

      {/* Same sheet treatment People and Schedule use, so a sheet is a sheet
          wherever the app opens one.

          `onDismiss` is the first hop of More → Stock → Restock: this sheet is
          the presenter the Stock door waits on. Without it the door would open
          only on useStagedSheet's 700ms safety net, which is meant to be the
          net and not the mechanism -- a visible pause between the tap and the
          sheet, on the one platform where the pause is the symptom. */}
      <AppModal
        visible={showMore}
        transparent
        animationType="slide"
        onRequestClose={() => setShowMore(false)}
        onDismiss={stockFromMore.onPresenterDismissed}
      >
        <Pressable style={styles.sheetOverlay} onPress={() => setShowMore(false)} accessibilityLabel="Close">
          {/* Stops a tap inside the sheet from closing it. */}
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>Inventory actions</Text>
              <Pressable onPress={() => setShowMore(false)} style={styles.pillButton}>
                <Text style={styles.pillButtonText}>Close</Text>
              </Pressable>
            </View>

            {showLocationFilter && (
              <View style={styles.sheetRow}>
                <Text style={styles.sheetRowLabel}>Store</Text>
                <Text style={styles.sheetRowHint}>Which store&apos;s stock the list shows</Text>
                <View style={styles.sheetControl}>
                  <StoreDropdown value={locationFilter} onChange={setLocationFilter} />
                </View>
              </View>
            )}

            {canEdit && (
              <Pressable onPress={() => { setShowMore(false); stockFromMore.open(true, compact); }} style={styles.sheetRow}>
                <Text style={styles.sheetRowLabel}>Stock</Text>
                <Text style={styles.sheetRowHint}>Restock, count, move, or import</Text>
              </Pressable>
            )}

            <View style={styles.sheetRow}>
              <Text style={styles.sheetRowLabel}>Export</Text>
              <Text style={styles.sheetRowHint}>
                {`${filtered.length} product${filtered.length === 1 ? '' : 's'} — whatever the list is showing now`}
              </Text>
              <View style={styles.sheetControl}>
                <ExportMenu
                  rows={filtered}
                  columns={PRODUCT_EXPORT_COLUMNS}
                  title="Inventory"
                  subtitle={`${filtered.length} products`}
                  filenamePrefix="inventory"
                />
              </View>
            </View>
          </Pressable>
        </Pressable>
      </AppModal>

      {shop && canEdit && (
        <ProductModal
          visible={showAddModal}
          // Done ends the whole episode, not just the form. Whatever the last
          // scan left behind -- the code in the search box, the result banner,
          // the pinned row, the offer to create -- was context for a decision
          // that has now been made, and leaving any of it up means the next
          // scan lands on a screen still showing the last one.
          onClose={() => {
            setShowAddModal(false);
            setUnknownCode(null);
            setSearch('');
            setPinnedProduct(null);
            setScanFeedback(null);
          }}
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
        <CsvImportModal
          // Suppressed while the restock or move sheet is being handed over
          // to, so iOS is never asked to present one modal over another -- see
          // useStagedSheet.
          visible={importOpen && !restockFromImport.presenterSuppressed && !moveFromImport.presenterSuppressed}
          onClose={actionFromStock.close}
          onDismissed={() => {
            restockFromImport.onPresenterDismissed();
            moveFromImport.onPresenterDismissed();
          }}
          config={importConfig}
          onImported={reload}
        />
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
      {/* The door. Suppressed while it is handing over to one of the four, so
          iOS is never asked to present a sheet over a sheet -- see
          useStagedSheet, and the same suppression on CsvImportModal above. */}
      {canEdit && (
        <StockActionsSheet
          visible={stockDoorOpen && !actionFromStock.presenterSuppressed}
          showCount={canCount}
          showMove={showLocationFilter && canTransfer}
          onClose={() => { setShowStockActions(false); stockFromMore.close(); }}
          onDismissed={actionFromStock.onPresenterDismissed}
          onPick={(action) => {
            setShowStockActions(false);
            stockFromMore.close();
            // `true`, not `compact`: the thing being opened FROM is this sheet,
            // and it is a modal at every width -- an iPad wide enough for the
            // desktop header still presents the door as one. Passing `compact`
            // here would say "not from a modal" on that iPad and hand iOS the
            // second modal to drop, which is a dead button on the one device
            // where nothing is logged when it happens.
            actionFromStock.open(action, true);
          }}
        />
      )}
      {shop && canEdit && (
        <StockRestockModal
          visible={showRestock}
          shopId={shop.id}
          onClose={() => {
            restockFromImport.close();
            actionFromStock.close();
          }}
          onDone={reload}
        />
      )}
      {shop && canCount && (
        <StockCountModal
          visible={showCount}
          shopId={shop.id}
          onClose={actionFromStock.close}
          onDone={reload}
        />
      )}
      {shop && canTransfer && (
        <StockTransferModal
          visible={transferOpen}
          shopId={shop.id}
          onClose={() => {
            moveFromImport.close();
            actionFromStock.close();
          }}
          onDone={reload}
        />
      )}
      {/* Only on a binary that cannot report keys from the window -- see
          `useWedgeSinkFallback`. Everywhere else `useBarcodeWedge` above hears
          the scanner without focusing anything, and this whole list of things
          it must stand down for stops existing.

          `keypadOpen` is on the list for the same reason the sheets are: the
          open keypad's field asks for focus, and the sink takes it back every
          700ms. Standing down costs no scanning -- a code scanned into the
          focused field is caught by the row's own burst rules. */}
      {sinkFallback && scanner.hardware && !keypadOpen && !scannerOpen && !showAddModal && editingProduct === null && !importOpen && !transferOpen && !showRestock && !showCount && !stockDoorOpen && (
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
  stockFilterRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  // The grey page the bento cards float on, matching Dashboard, Accounting and
  // People.
  safeArea: { flex: 1, backgroundColor: theme.bentoPage },
  content: { padding: 18, paddingBottom: 60 },
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
  headerTitles: { flexShrink: 1 },
  eyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, color: theme.bentoMuted, marginBottom: 3 },
  title: { color: theme.bentoInk, fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  subtitle: { color: theme.bentoMuted, fontSize: 13, marginTop: 3 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'flex-end' },
  pillButton: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSurface,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  pillButtonSolid: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  pillButtonDisabled: { opacity: 0.5 },
  pillButtonText: { color: theme.bentoInk2, fontWeight: '700', fontSize: 12.5 },
  pillButtonTextSolid: { color: theme.bentoSurface },
  strip: { marginBottom: 14 },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  limitNote: { color: '#9A6412', fontSize: 12, lineHeight: 18, marginBottom: 12 },
  stockError: { color: theme.bentoLoss, fontSize: 13, fontWeight: '700', marginBottom: 12 },
  // A row rather than a single button now: the offer and the way out of it are
  // two separate targets inside one pill, so pressing × cannot be read as
  // pressing Add.
  addFromScan: { backgroundColor: theme.bentoInk, borderRadius: 999, marginBottom: 14, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', paddingRight: 5 },
  addFromScanBody: { paddingLeft: 15, paddingRight: 6, paddingVertical: 11 },
  addFromScanText: { color: theme.bentoSurface, fontSize: 12, fontWeight: '800' },
  addFromScanDismiss: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  // Quiet against the pill's own white text: this is the undo, not the offer.
  addFromScanDismissText: { color: theme.bentoSurface, opacity: 0.6, fontSize: 12, fontWeight: '800', includeFontPadding: false, textAlignVertical: 'center' },
  // Zero padding and clipped, so rows run to the card's edges and the first and
  // last take the 26px corner.
  list: { overflow: 'hidden' },
  empty: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', paddingVertical: 10, lineHeight: 20 },
  // Same sheet treatment People and Schedule use.
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.bentoPage, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16, paddingBottom: 28 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.3 },
  sheetRow: { backgroundColor: theme.bentoSurface, borderRadius: 16, paddingHorizontal: 15, paddingVertical: 13, marginBottom: 8 },
  sheetRowLabel: { fontSize: 14, fontWeight: '700', color: theme.bentoInk },
  sheetRowHint: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2 },
  sheetControl: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});

// Wrapped so a shop whose plan doesn't cover this screen gets the upgrade wall
// HERE, in the slot the screen would have filled, rather than in place of the
// whole `(admin)` navigator -- which is what used to happen, and what left a
// lapsed shop with no rail, no ☰ and no tab bar. See components/module-wall.tsx.
export default withModuleWall('inventory', InventoryScreen);
