import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BarcodeScannerModal } from '@/components/barcode-scanner-modal';
import { CategoryChip } from '@/components/category-chip';
import { ProductModal } from '@/components/product-modal';
import { CheckoutPanel } from '@/components/checkout-panel';
import { DiscountEditor } from '@/components/discount-editor';
import { QuantityStepper } from '@/components/quantity-stepper';
import { ReceiptModal } from '@/components/receipt-modal';
import { ScanFeedbackBanner } from '@/components/scan-feedback-banner';
import { WedgeSink } from '@/components/wedge-sink';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { useAuth } from '@/hooks/use-auth';
import { useBarcodeWedge } from '@/hooks/use-barcode-wedge';
import { usePosSessionField } from '@/hooks/use-pos-session';
import { useScannerSettings } from '@/hooks/use-scanner-settings';
import { barcodeCandidates, looksLikeBarcode, posScanOutcome, type ScanFeedback } from '@/lib/barcode';
import { listCashiers } from '@/lib/cashiers';
import { listCategories } from '@/lib/categories';
import { cartTotalCents } from '@/lib/cart';
import { confirmDestructive } from '@/lib/confirm';
import { listCurrencies } from '@/lib/currencies';
import { formatCents } from '@/lib/currency';
import { appliedPromotionForLine, cartSubtotalCents, discountAmountCents, lineDiscountCents, lineGrossCents } from '@/lib/discounts';
import { effectiveRedemption, maxRedeemablePoints, pointsEarnedFor, type LoyaltySettings } from '@/lib/loyalty';
import { hasMultipleLocations } from '@/lib/location-selection';
import { createProduct, findProductsByCode, listProducts } from '@/lib/products';
import { listPromotions } from '@/lib/promotions';
import { formatTodayHours, storeNameFor, type ReceiptData } from '@/lib/receipt';
import { completeSale } from '@/lib/sales';
import { taxCentsFor } from '@/lib/tax';
import type { Currency, Discount, NewProductInput, PaymentMethod, Product, Promotion } from '@/types/models';

// Real `Error` instances have `.message`, but Supabase's `rpc()`/query errors
// (e.g. PostgrestError from the complete_sale RPC — "insufficient stock for
// X: has 7, need 100") are plain `{code, details, hint, message}` objects
// that are never `instanceof Error`. Check for a string `.message` on either
// shape so the user sees the RPC's actual reason instead of a generic one.
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Could not complete this sale.';
}

export default function PosScreen() {
  const { shop, can, locations, activeLocation, limitFor, usageOf } = useAuth();
  const showLocationName = hasMultipleLocations(locations);
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;
  // 'other' is deliberately excluded here — PaymentMethodPicker always
  // offers it regardless, since it isn't a toggle a shop can turn off.
  const enabledPaymentMethods: PaymentMethod[] = [
    ...(shop?.paymentCashEnabled ?? true ? (['cash'] as const) : []),
    ...(shop?.paymentZaadEnabled ?? true ? (['zaad'] as const) : []),
    ...(shop?.paymentEdahabEnabled ?? true ? (['edahab'] as const) : []),
  ];
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  // These five track the in-progress sale, so they're backed by
  // usePosSessionField rather than plain useState — see use-pos-session.ts
  // for why (the admin tab shell remounts this screen on every tab switch).
  const [cart, setCart] = usePosSessionField('cart');
  const [payments, setPayments] = usePosSessionField('payments');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryColors, setCategoryColors] = useState<Map<string, string | null>>(new Map());
  const [selectedCustomer, setSelectedCustomer] = usePosSessionField('selectedCustomer');
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [cashiers, setCashiers] = useState<string[]>([]);
  // Unlike customer info (cleared after every sale), the cashier stays
  // selected across sales — whoever is running the register doesn't change
  // sale-to-sale, so re-picking it each time would just be busywork.
  const [cashierName, setCashierName] = usePosSessionField('cashierName');
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [editingLineDiscount, setEditingLineDiscount] = useState<string | null>(null);
  const [transactionDiscount, setTransactionDiscount] = usePosSessionField('transactionDiscount');
  const [editingTransactionDiscount, setEditingTransactionDiscount] = useState(false);
  const [pointsRedeemed, setPointsRedeemed] = usePosSessionField('pointsRedeemed');
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  // Height of a single compact grid tile, measured from the first rendered
  // tile — rows stretch every tile to match the tallest in that row, so this
  // doubles as the row height. Used to cap the mobile product grid at 2 rows.
  const [compactTileHeight, setCompactTileHeight] = useState<number | null>(null);
  // The result of the last scan. Deliberately transient (see the clearing
  // effect below): a cashier scanning a basket needs to glance at the outcome,
  // not dismiss a notice per item.
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const scanner = useScannerSettings();
  // Same three gates Inventory applies. A cashier without `inventory.edit`
  // simply sees the error -- the products insert policy would refuse them
  // anyway, and offering a form that can't be saved is worse than not offering
  // one.
  const productLimit = limitFor('products');
  const atProductLimit = productLimit != null && usageOf('products') >= productLimit;
  const canCreateProduct = can('inventory.edit') && !atProductLimit;

  // Scoped to the register's store, which is what checkout will actually
  // decrement. Unscoped this listed the shop-wide rollup, so a cashier saw "99
  // in stock" for something their store doesn't carry, added it, and had
  // complete_sale refuse with "insufficient stock at this location" — the UI
  // promising what the server rejects. It also now lists only what this store
  // carries, so the grid stops offering the other stores' catalog.
  const reload = useCallback(async () => {
    if (!shop) return;
    setProducts(await listProducts(shop.id, activeLocation?.id ?? null));
  }, [shop, activeLocation]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!shop) return;
    listCategories(shop.id)
      .then((rows) => {
        setCategories(rows.map((r) => r.name));
        setCategoryColors(new Map(rows.map((r) => [r.name, r.color])));
      })
      .catch(() => {});
  }, [shop]);
  useEffect(() => { if (shop) listCashiers(shop.id).then((rows) => setCashiers(rows.map((r) => r.name))).catch(() => {}); }, [shop]);
  useEffect(() => { if (shop) listPromotions(shop.id).then(setPromotions).catch(() => {}); }, [shop]);
  useEffect(() => {
    if (!shop) return;
    listCurrencies(shop.id).then((rows) => setCurrencies(rows.filter((c) => c.active))).catch(() => {});
  }, [shop]);

  // Brand, SKU and barcode alongside name: the placeholder always promised
  // brand, and the code fields are what make a partially-typed or ambiguous
  // scan land on something -- putting a barcode in here used to match nothing
  // at all.
  const filtered = products.filter((p) => {
    const q = search.trim().toLowerCase();
    const matches =
      !q ||
      p.name.toLowerCase().includes(q) ||
      (p.brand ?? '').toLowerCase().includes(q) ||
      (p.sku ?? '').toLowerCase().includes(q) ||
      (p.barcode ?? '').toLowerCase().includes(q);
    return matches && (category === null || p.category === category);
  });

  const addToCart = (product: Product) => {
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing) return current.map((line) => (line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line));
      return [...current, { product, quantity: 1 }];
    });
  };

  const setQuantity = (productId: string, quantity: number) => {
    setCart((current) => (quantity === 0 ? current.filter((line) => line.product.id !== productId) : current.map((line) => (line.product.id === productId ? { ...line, quantity } : line))));
  };

  const setLineDiscount = (productId: string, discount: Discount | null) => {
    setCart((current) => current.map((line) => (line.product.id === productId ? { ...line, manualDiscount: discount } : line)));
  };

  // One entry point for every source of a scanned code: the hardware wedge
  // below, Enter in the search box, and (from the next phase) the camera.
  //
  // Not wrapped in useCallback: `useBarcodeWedge` keeps it in a ref, so its
  // identity is irrelevant, and the React Compiler handles the rest.
  const handleScannedCode = async (raw: string) => {
    const outcome = posScanOutcome(products, cart, raw);
    switch (outcome.kind) {
      case 'add':
        addToCart(outcome.product);
        setScanFeedback({ tone: 'ok', message: `${outcome.product.name} added` });
        return true;
      case 'out-of-stock':
        setScanFeedback({ tone: 'error', message: `${outcome.product.name} is out of stock at this store` });
        return true;
      case 'exceeds-stock':
        setScanFeedback({
          tone: 'warn',
          message: `Only ${outcome.product.stock} of ${outcome.product.name} in stock — all of them are already in the cart`,
        });
        return true;
      case 'ambiguous':
        // Deliberately not resolved here. Narrowing the grid to the candidates
        // lets the cashier tap the right one, which is the only safe answer.
        setSearch(raw.trim());
        setScanFeedback({ tone: 'warn', message: `${outcome.products.length} products share this code — pick the right one` });
        return true;
      case 'unknown': {
        // The catalog in state can predate another till adding this product, so
        // one lookup before calling it unknown.
        if (shop) {
          try {
            const found = await findProductsByCode(shop.id, barcodeCandidates(outcome.code));
            if (found.length === 1) {
              setProducts((current) => (current.some((p) => p.id === found[0].id) ? current : [found[0], ...current]));
              addToCart(found[0]);
              setScanFeedback({ tone: 'ok', message: `${found[0].name} added` });
              return true;
            }
          } catch {
            // Offline or refused: fall through to the unknown message rather
            // than surface a network error for what is still a failed scan.
          }
        }
        setUnknownCode(canCreateProduct ? outcome.code : null);
        setScanFeedback({
          tone: 'error',
          message: atProductLimit
            ? `No product with code ${outcome.code}. Your plan is at its product limit — remove one, or upgrade, before adding it.`
            : `No product with code ${outcome.code}`,
        });
        return false;
      }
    }
  };

  // Creating the product the cashier just scanned, mid-sale, and dropping it
  // straight into the basket.
  //
  // A named function rather than an arrow inline on the modal: the React
  // Compiler cannot preserve the surrounding memoization when a closure this
  // wide (products, cart, the session-backed setters) is built inside JSX.
  const createProductFromScan = async (input: NewProductInput, locationId: string | null) => {
    if (!shop) return;
    const created = await createProduct(shop.id, input, locationId ?? activeLocation?.id ?? null);
    setProducts((current) => [created, ...current]);
    // Only if it actually has stock here -- otherwise the grid's own rule
    // (out-of-stock items can't be added) would be contradicted by the scan.
    if (created.stock > 0) addToCart(created);
    setUnknownCode(null);
    setScanFeedback({ tone: 'ok', message: `${created.name} created and added` });
  };

  // Enter in the search box. A wedge scanner types into whatever is focused, so
  // this covers the cashier who clicked the box first, on native as well as web.
  const handleSearchSubmit = async () => {
    const raw = search.trim();
    if (!raw || !scanner.resolveCodes) return;
    const outcome = posScanOutcome(products, cart, raw);
    // Someone searching for "toner" and pressing Enter is not a failed scan.
    // Staying silent here is what keeps the box feeling like a search box.
    if (outcome.kind === 'unknown' && !looksLikeBarcode(raw)) return;
    const handled = await handleScannedCode(raw);
    // Clear only on a hit: a wedge's next scan would otherwise be appended to
    // this one. On a miss the text stays so it can be read and corrected.
    if (handled) setSearch('');
  };

  useBarcodeWedge({
    // Off unless this store says it has a wedge scanner: the hook listens to
    // every keystroke on the page, which is only worth doing where such a
    // scanner exists. Also off while the receipt or the camera scanner is up --
    // the sale is already done, or that modal owns input.
    enabled: scanner.hardware && receipt === null && !scannerOpen,
    onScan: handleScannedCode,
  });

  useEffect(() => {
    if (!scanFeedback) return;
    const timer = setTimeout(() => setScanFeedback(null), 3500);
    return () => clearTimeout(timer);
  }, [scanFeedback]);

  const grossCents = cartTotalCents(cart);
  const subtotalCents = cartSubtotalCents(cart, promotions);
  const transactionDiscountCents = discountAmountCents(subtotalCents, transactionDiscount);
  // Points come off after the cashier's discount and before tax, mirroring
  // complete_sale — a redemption is a seller-funded price reduction, so tax
  // applies to the reduced price. See migration 20260820000000.
  const preRedemptionCents = subtotalCents - transactionDiscountCents;
  const loyalty: LoyaltySettings = {
    enabled: shop?.loyaltyEnabled ?? false,
    pointsPerUsd: shop?.loyaltyPointsPerUsd ?? 1,
    centsPerPoint: shop?.loyaltyCentsPerPoint ?? 1,
  };
  // Re-clamped on every render rather than corrected imperatively when the cart
  // changes: shrink the basket and the redemption shrinks with it, which moves
  // `total` and so trips the clear-payments effect below, exactly as a discount
  // change would.
  // Spendable points, not the whole balance: anything earned inside the shop's
  // maturing window is on the balance but can't be redeemed yet. Null means the
  // lookup hasn't landed, which reads as zero here — the server would refuse a
  // redemption built on a guess anyway.
  const spendablePoints = selectedCustomer?.availablePoints ?? 0;
  const redemption = effectiveRedemption(
    pointsRedeemed,
    preRedemptionCents,
    spendablePoints,
    loyalty,
    Boolean(selectedCustomer)
  );
  const preTaxTotalCents = preRedemptionCents - redemption.cents;
  const taxCents = shop?.taxEnabled ? taxCentsFor(preTaxTotalCents, shop.taxRatePercent) : 0;
  const total = preTaxTotalCents + taxCents;
  // Points get their own summary line, so they must not also inflate the
  // "Discount" one.
  const hasAnyDiscount = grossCents !== preRedemptionCents;
  const pointsEarned = loyalty.enabled && selectedCustomer ? pointsEarnedFor(preTaxTotalCents, loyalty.pointsPerUsd) : 0;
  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const fullyPaid = payments.length > 0 && paidCents === total;

  // Any cart change invalidates whatever's already been entered in the
  // payment picker (the amounts no longer sum to the new total), so clear
  // it rather than let a stale split silently under/over-cover the sale.
  useEffect(() => { setPayments([]); }, [total, setPayments]);

  const checkout = async () => {
    if (!shop || cart.length === 0 || !fullyPaid) return;
    // Refuse rather than let complete_sale fall back to the primary location.
    // The fallback exists for callers that never had a location (CSV import, an
    // older client); here the register genuinely has one and simply hasn't
    // resolved yet, so guessing would file the sale against the wrong branch --
    // and a sale in the wrong store's takings is far harder to unpick than one
    // the cashier had to retry.
    if (!activeLocation) {
      setError('No location selected for this register. Pick one from the header before ringing up a sale.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await completeSale(
        shop.id,
        cart,
        payments,
        {
          id: selectedCustomer?.id ?? null,
          name: selectedCustomer?.name ?? null,
          phone: selectedCustomer?.phone ?? null,
          email: selectedCustomer?.email ?? null,
        },
        cashierName,
        promotions,
        transactionDiscountCents,
        activeLocation.id,
        redemption.points
      );
      setReceipt({
        shopName: shop.name,
        shopLogoUrl: shop.receiptShowLogo ? shop.logoUrl : null,
        // The branch's own address, phone and hours -- what the customer needs
        // to find their way back. The name is only printed when there is more
        // than one branch to tell apart.
        locationName: storeNameFor(shop.name, activeLocation.name, showLocationName),
        shopCity: activeLocation.city,
        shopNeighborhood: activeLocation.neighborhood,
        shopContactPhone: activeLocation.contactPhone,
        shopHours: formatTodayHours(activeLocation.openingHours, new Date()),
        cashierName: shop.receiptShowCashierName ? cashierName : null,
        returnPolicy: shop.returnPolicy,
        items: cart.map((line) => ({
          name: line.product.name,
          quantity: line.quantity,
          unitPriceCents: line.product.priceCents,
          discountCents: lineDiscountCents(line, promotions),
        })),
        payments,
        customer: { name: selectedCustomer?.name ?? null, phone: selectedCustomer?.phone ?? null, email: selectedCustomer?.email ?? null },
        subtotalCents: grossCents,
        // Stops short of the redemption on purpose: points print as their own
        // line, and folding them in here would report a discount the shop
        // didn't give.
        discountCents: grossCents - preRedemptionCents,
        taxCents,
        taxRatePercent: shop.taxEnabled ? shop.taxRatePercent : null,
        pointsRedeemed: redemption.points,
        pointsRedeemedCents: redemption.cents,
        pointsEarned,
        totalCents: total,
        createdAt: new Date().toISOString(),
      });
      setCart([]);
      setPayments([]);
      setSelectedCustomer(null);
      setTransactionDiscount(null);
      setPointsRedeemed(0);
      setEditingTransactionDiscount(false);
      setEditingLineDiscount(null);
      await reload();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const clearSale = () => {
    if (cart.length === 0) return;
    confirmDestructive('Clear cart?', 'This removes every item from the current sale.', 'Clear cart', () => {
      setCart([]);
      setPayments([]);
      setSelectedCustomer(null);
      setTransactionDiscount(null);
      setPointsRedeemed(0);
      setEditingTransactionDiscount(false);
      setEditingLineDiscount(null);
      setError(null);
    });
  };

  // On desktop, browse + cart are independently-scrolling side-by-side
  // panes, each owning its own `ScrollView` for its category row / grid /
  // cart list. On mobile there's no room for two panes side by side, so the
  // whole screen becomes one vertical scroller instead — and nesting a
  // flex-sized `ScrollView` inside that (even with `scrollEnabled={false}`)
  // fights React Native's own default flex sizing for `ScrollView` (it wants
  // to flex/grow along whichever axis its container scrolls) in ways that
  // are very hard to fully override, producing zero-height or overflowing
  // panes. Swapping to plain `View`s for those inner containers on mobile
  // sidesteps that entirely — they just flow with the outer page scroll like
  // normal content.
  //
  // The product grid is the one exception: it's given an explicit pixel
  // height (2 rows, via `compactTileHeight`) rather than a flex size, so it
  // doesn't hit the sizing fight above — it can scroll on its own, letting
  // shoppers reach the cart without paging through every product first.
  const Split = compact ? ScrollView : View;
  const splitProps = compact ? { contentContainerStyle: styles.splitCompactContent } : {};
  const categoryListProps = compact
    ? { horizontal: true, showsHorizontalScrollIndicator: false, style: styles.categoryScrollCompact, contentContainerStyle: styles.categoryRowCompact }
    : { horizontal: true, showsHorizontalScrollIndicator: false, style: styles.categoryScroll, contentContainerStyle: styles.categoryRow };
  const GridList = ScrollView;
  const compactGridHeight = compactTileHeight ? compactTileHeight * 2 + 8 : undefined;
  const gridListProps = compact
    ? {
        style: [styles.gridScrollCompact, compactGridHeight ? { maxHeight: compactGridHeight } : null],
        contentContainerStyle: [styles.grid, styles.gridCompact],
        nestedScrollEnabled: true,
      }
    : { contentContainerStyle: styles.grid };
  // Compact mode caps the cart's own scroll instead of letting it grow with
  // the page, so the total/checkout stay reachable without paging past a
  // long line-item list — the same idea as compactGridHeight above.
  const cartListProps = compact
    ? { style: styles.cartListCompact, nestedScrollEnabled: true, showsVerticalScrollIndicator: false }
    : { style: styles.cartList };

  const browsePaneEl = (
    <View style={[styles.browsePane, compact && styles.browsePaneCompact]}>
      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search or scan a product"
          placeholderTextColor="#9B9B9B"
          style={styles.search}
          onSubmitEditing={handleSearchSubmit}
          // A wedge scanner fires this on its trailing Enter; keeping focus
          // means the next scan lands here too instead of nowhere.
          blurOnSubmit={false}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {scanner.camera && (
          <Pressable onPress={() => setScannerOpen(true)} style={styles.scanInSearch} accessibilityLabel="Scan a barcode">
            <Text style={styles.scanInSearchText}>⛶</Text>
          </Pressable>
        )}
      </View>
      <ScanFeedbackBanner feedback={scanFeedback} />
      {unknownCode && (
        <Pressable onPress={() => { setScannerOpen(false); setShowAddProduct(true); }} style={styles.addFromScan}>
          <Text style={styles.addFromScanText}>+ Add a product with barcode {unknownCode}</Text>
        </Pressable>
      )}
      <ScrollView {...categoryListProps}>
        <CategoryChip label="All" active={category === null} onPress={() => setCategory(null)} />
        {categories.map((item) => (
          <CategoryChip key={item} label={item} color={categoryColors.get(item)} active={category === item} onPress={() => setCategory(item)} />
        ))}
      </ScrollView>
      <GridList {...gridListProps}>
        {filtered.map((product, index) => (
          <Pressable
            key={product.id}
            onPress={() => addToCart(product)}
            disabled={product.stock <= 0}
            onLayout={compact && index === 0 ? (e) => setCompactTileHeight(e.nativeEvent.layout.height) : undefined}
            style={[styles.gridTile, compact && styles.gridTileCompact, product.stock <= 0 && styles.gridTileDisabled]}
          >
            {product.imageUrl ? (
              <Image source={{ uri: product.imageUrl }} contentFit="cover" style={[styles.gridThumb, compact && styles.gridThumbCompact]} />
            ) : (
              <View style={[styles.gridThumb, compact && styles.gridThumbCompact, styles.gridThumbPlaceholder]}>
                <View style={[styles.gridThumbDrop, compact && styles.gridThumbDropCompact, product.stock <= 0 && styles.gridThumbDropMuted]} />
              </View>
            )}
            {product.brand && <Text style={[styles.gridBrand, compact && styles.gridBrandCompact]}>{product.brand.toUpperCase()}</Text>}
            <Text style={[styles.gridName, compact && styles.gridNameCompact]} numberOfLines={2}>{product.name}</Text>
            <View style={[styles.gridFooter, compact && styles.gridFooterCompact]}>
              <Text style={[styles.gridPrice, compact && styles.gridPriceCompact]}>{formatCents(product.priceCents)}</Text>
              {product.stock <= 0 ? (
                <Text style={[styles.stockPill, compact && styles.stockPillCompact]}>⚠ Out of stock</Text>
              ) : (
                <View style={styles.gridStockWithBadge}>
                  <Text style={[styles.gridStock, compact && styles.gridStockCompact]}>{product.stock} in stock</Text>
                  {product.stock <= (product.reorderLevel ?? 5) && <Text style={[styles.stockPill, compact && styles.stockPillCompact]}>⚠ Low stock</Text>}
                </View>
              )}
            </View>
          </Pressable>
        ))}
      </GridList>
    </View>
  );

  const cartPaneEl = (
    <View style={[styles.cartPane, compact && styles.cartPaneCompact]}>
      <View style={styles.cartTitleRow}>
        <Text style={styles.cartTitle}>Current sale</Text>
        <View style={styles.cartTitleActions}>
          {/* Beside the sale itself, not only above the product grid. On a
              phone the cart renders ABOVE the browse pane, so this is the one
              scan control that stays in reach mid-checkout without scrolling
              back up past the whole basket. */}
          {scanner.camera && (
            <Pressable onPress={() => setScannerOpen(true)} style={styles.scanCartButton}>
              <Text style={styles.scanCartButtonText}>⛶ Scan</Text>
            </Pressable>
          )}
          {cart.length > 0 && (
            <Pressable onPress={clearSale} style={styles.clearAll}>
              <Text style={styles.clearAllText}>⌫ Clear all</Text>
            </Pressable>
          )}
        </View>
      </View>
      <ScrollView {...cartListProps}>
        {cart.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyIcon}>🛒</Text>
            <Text style={styles.empty}>Cart is empty.{'\n'}Tap a product to add it.</Text>
          </View>
        ) : (
          cart.map((line) => {
            const gross = lineGrossCents(line);
            const discountCents = lineDiscountCents(line, promotions);
            const promo = appliedPromotionForLine(line, promotions);
            const isEditing = editingLineDiscount === line.product.id;
            return (
              <View key={line.product.id} style={styles.cartLine}>
                <View style={styles.cartLineRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cartLineName}>{line.product.name}</Text>
                    <View style={styles.cartLinePriceRow}>
                      {discountCents > 0 ? (
                        <>
                          <Text style={styles.cartLinePriceStruck}>{formatCents(gross)}</Text>
                          <Text style={styles.cartLinePrice}>{formatCents(gross - discountCents)}</Text>
                        </>
                      ) : (
                        <Text style={styles.cartLinePrice}>{formatCents(line.product.priceCents)}</Text>
                      )}
                    </View>
                    {promo && !line.manualDiscount && <Text style={styles.cartLinePromo}>🏷 {promo.name}</Text>}
                    <Pressable onPress={() => setEditingLineDiscount(isEditing ? null : line.product.id)}>
                      <Text style={styles.cartLineDiscountToggle}>{line.manualDiscount ? 'Edit discount' : '+ Add discount'}</Text>
                    </Pressable>
                  </View>
                  <QuantityStepper quantity={line.quantity} onChange={(next) => setQuantity(line.product.id, next)} />
                </View>
                {isEditing && (
                  <DiscountEditor
                    initial={line.manualDiscount}
                    onApply={(discount) => { setLineDiscount(line.product.id, discount); setEditingLineDiscount(null); }}
                    onRemove={line.manualDiscount ? () => { setLineDiscount(line.product.id, null); setEditingLineDiscount(null); } : undefined}
                  />
                )}
              </View>
            );
          })
        )}
      </ScrollView>
      <View style={styles.discountSection}>
        {hasAnyDiscount && (
          <>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Subtotal</Text>
              <Text style={styles.summaryValue}>{formatCents(grossCents)}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Discount</Text>
              <Text style={styles.summaryValueDiscount}>-{formatCents(grossCents - preRedemptionCents)}</Text>
            </View>
          </>
        )}
        {redemption.points > 0 && (
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Points ({redemption.points.toLocaleString()})</Text>
            <Text style={styles.summaryValueDiscount}>-{formatCents(redemption.cents)}</Text>
          </View>
        )}
        {taxCents > 0 && (
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Tax ({shop?.taxRatePercent}%)</Text>
            <Text style={styles.summaryValue}>{formatCents(taxCents)}</Text>
          </View>
        )}
        <Pressable onPress={() => setEditingTransactionDiscount((v) => !v)}>
          <Text style={styles.cartLineDiscountToggle}>
            {transactionDiscount ? 'Edit order discount' : '+ Add order discount'}
          </Text>
        </Pressable>
        {editingTransactionDiscount && (
          <DiscountEditor
            initial={transactionDiscount}
            onApply={(discount) => { setTransactionDiscount(discount); setEditingTransactionDiscount(false); }}
            onRemove={transactionDiscount ? () => { setTransactionDiscount(null); setEditingTransactionDiscount(false); } : undefined}
          />
        )}
      </View>
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalValue}>{formatCents(total)}</Text>
      </View>
      {pointsEarned > 0 && <Text style={styles.earnsPoints}>Earns {pointsEarned.toLocaleString()} points</Text>}

      {shop && (
        <CheckoutPanel
          cartEmpty={cart.length === 0}
          cashiers={cashiers}
          cashierName={cashierName}
          onSelectCashier={(name) => setCashierName((current) => (current === name ? null : name))}
          shopId={shop.id}
          selectedCustomer={selectedCustomer}
          // A redemption is against one specific balance, so changing or
          // clearing the customer has to drop it rather than carry it over.
          onSelectCustomer={(customer) => { setSelectedCustomer(customer); setPointsRedeemed(0); }}
          onClearCustomer={() => { setSelectedCustomer(null); setPointsRedeemed(0); }}
          totalCents={total}
          payments={payments}
          currencies={currencies}
          onChangePayments={setPayments}
          enabledPaymentMethods={enabledPaymentMethods}
          allowSplit={shop?.paymentSplitEnabled ?? true}
          fullyPaid={fullyPaid}
          submitting={submitting}
          error={error}
          onCheckout={checkout}
          loyaltyEnabled={loyalty.enabled}
          centsPerPoint={loyalty.centsPerPoint}
          pointsRedeemed={pointsRedeemed}
          maxRedeemable={maxRedeemablePoints(preRedemptionCents, spendablePoints, loyalty)}
          pointsMaturing={Math.max((selectedCustomer?.pointsBalance ?? 0) - spendablePoints, 0)}
          availableKnown={selectedCustomer?.availablePoints !== null && selectedCustomer?.availablePoints !== undefined}
          redemptionCents={redemption.cents}
          pointsEarned={pointsEarned}
          onChangePointsRedeemed={setPointsRedeemed}
        />
      )}
    </View>
  );

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <Split style={[styles.split, compact && styles.splitCompact]} {...splitProps}>
        {compact ? (
          <>
            {cartPaneEl}
            {browsePaneEl}
          </>
        ) : (
          <>
            {browsePaneEl}
            {cartPaneEl}
          </>
        )}
      </Split>
      <ReceiptModal
        receipt={receipt}
        onClose={() => setReceipt(null)}
        title="Sale complete ✓"
        autoPrint={shop?.receiptAutoPrint ?? false}
        autoSendWhatsApp={shop?.receiptAutoWhatsapp ?? false}
      />
      {/* Native counterpart to useBarcodeWedge, on the same store setting.
          Unmounted whenever a modal owns the keyboard, so it never competes for
          focus with a form the cashier is filling in. */}
      {scanner.hardware && !scannerOpen && !showAddProduct && receipt === null && (
        <WedgeSink onScan={handleScannedCode} />
      )}
      {/* Scanning something the shop doesn't stock yet is a normal event mid-
          sale (new delivery, mislabelled item). Creating it here and dropping
          it straight into the cart beats abandoning the sale to go to
          Inventory and starting over. */}
      {shop && (
        <ProductModal
          visible={showAddProduct}
          onClose={() => { setShowAddProduct(false); setUnknownCode(null); }}
          shopId={shop.id}
          defaultLocationId={activeLocation?.id ?? null}
          defaults={unknownCode ? { barcode: unknownCode } : undefined}
          onSubmit={createProductFromScan}
        />
      )}
      {/* Continuous: a cashier scanning a basket of eight items should not
          reopen the camera eight times. */}
      <BarcodeScannerModal
        visible={scannerOpen}
        onClose={() => { setScannerOpen(false); setScanFeedback(null); }}
        onScan={handleScannedCode}
        mode="continuous"
        title="Scan into this sale"
        hint="Point the camera at a barcode. Keep scanning to add more items."
        feedback={scanFeedback}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  split: { flex: 1, flexDirection: 'row' },
  splitCompact: { flex: 1, flexDirection: 'column' },
  splitCompactContent: { flexDirection: 'column', width: '100%', minWidth: 0 },
  browsePane: { flex: 2, padding: 32 },
  browsePaneCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0, padding: 20, paddingBottom: 12 },
  searchWrap: { position: 'relative', justifyContent: 'center', marginBottom: 20 },
  searchIcon: { position: 'absolute', left: 18, color: '#9B9B9B', fontSize: 18, zIndex: 1 },
  // paddingRight leaves room for the scan button overlaid on the right.
  search: { backgroundColor: '#F4F4F4', borderRadius: 14, height: 52, paddingLeft: 42, paddingRight: 52, fontSize: 15, color: '#111111' },
  categoryScroll: { flexGrow: 0, flexShrink: 0 },
  categoryRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 24 },
  categoryScrollCompact: { flexGrow: 0, flexShrink: 0 },
  categoryRowCompact: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
  gridCompact: { gap: 8 },
  gridScrollCompact: { flexGrow: 0, flexShrink: 0 },
  gridTile: { flexBasis: '31%', flexGrow: 0, flexShrink: 0, minWidth: 190, backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, borderWidth: 1, borderColor: '#EDEDED' },
  gridTileCompact: { flexBasis: '31%', minWidth: 90, flexGrow: 0, flexShrink: 0, borderRadius: 12, padding: 8 },
  gridTileDisabled: { opacity: 0.4 },
  gridThumb: { width: '100%', aspectRatio: 1, borderRadius: 14, marginBottom: 14 },
  gridThumbCompact: { aspectRatio: 1.3, borderRadius: 8, marginBottom: 6 },
  gridThumbPlaceholder: { backgroundColor: '#F2F2F2', alignItems: 'center', justifyContent: 'center' },
  // A teardrop silhouette built from a rotated square with three rounded
  // corners — avoids pulling in an icon/SVG library just for one glyph, and
  // (unlike the 💧 emoji) its color is fully controllable to match the
  // monochrome palette and dim for out-of-stock items.
  gridThumbDrop: {
    width: 30,
    height: 30,
    backgroundColor: '#111111',
    borderTopLeftRadius: 15,
    borderTopRightRadius: 15,
    borderBottomRightRadius: 15,
    borderBottomLeftRadius: 0,
    transform: [{ rotate: '-45deg' }],
  },
  gridThumbDropCompact: { width: 16, height: 16, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomRightRadius: 8 },
  gridThumbDropMuted: { backgroundColor: '#C7C7C7' },
  gridBrand: { color: '#999999', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  gridBrandCompact: { fontSize: 8 },
  gridName: { color: '#111111', fontSize: 15, fontWeight: '700', minHeight: 40, marginTop: 4 },
  gridNameCompact: { fontSize: 11, minHeight: 15, marginTop: 2 },
  gridFooter: { marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gridFooterCompact: { marginTop: 5, flexDirection: 'column', alignItems: 'flex-start', gap: 2 },
  gridPrice: { color: '#111111', fontSize: 18, fontWeight: '800' },
  gridPriceCompact: { fontSize: 13 },
  gridStock: { color: '#999999', fontSize: 12 },
  gridStockCompact: { fontSize: 9 },
  gridStockWithBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  stockPill: { fontSize: 11, fontWeight: '700', color: '#555555', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D8D8D8', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, alignSelf: 'flex-start' },
  stockPillCompact: { fontSize: 8, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8 },
  cartPane: { flex: 1, backgroundColor: '#FFFFFF', borderLeftWidth: 1, borderLeftColor: '#ECECEC', padding: 28, minWidth: 320 },
  cartPaneCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0, borderLeftWidth: 0, borderBottomWidth: 1, borderBottomColor: '#ECECEC', padding: 20, paddingBottom: 16 },
  cartTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 8 },
  cartTitleActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scanCartButton: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  scanCartButtonText: { color: '#111111', fontSize: 12, fontWeight: '800' },
  scanInSearch: { position: 'absolute', right: 6, height: 40, width: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  scanInSearchText: { fontSize: 17, color: '#111111' },
  addFromScan: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 11, marginBottom: 14 },
  addFromScanText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  cartTitle: { color: '#111111', fontSize: 22, fontWeight: '800' },
  clearAll: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  clearAllText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  cartList: { flex: 1 },
  cartListCompact: { maxHeight: 240, marginBottom: 4 },
  emptyWrap: { alignItems: 'center', marginTop: 56 },
  emptyIcon: { fontSize: 32, marginBottom: 12, opacity: 0.5 },
  empty: { color: '#BBBBBB', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  cartLine: { backgroundColor: '#FAFAFA', borderRadius: 14, padding: 14, marginBottom: 10 },
  cartLineRow: { flexDirection: 'row', alignItems: 'center' },
  cartLineName: { color: '#111111', fontSize: 14, fontWeight: '700' },
  cartLinePriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  cartLinePrice: { color: '#999999', fontSize: 12 },
  cartLinePriceStruck: { color: '#BBBBBB', fontSize: 12, textDecorationLine: 'line-through' },
  cartLinePromo: { color: '#111111', fontSize: 11, fontWeight: '700', marginTop: 4 },
  cartLineDiscountToggle: { color: '#999999', fontSize: 11, fontWeight: '700', marginTop: 6 },
  discountSection: { marginTop: 4 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  summaryLabel: { color: '#999999', fontSize: 13 },
  summaryValue: { color: '#111111', fontSize: 13, fontWeight: '600' },
  summaryValueDiscount: { color: '#C0392B', fontSize: 13, fontWeight: '700' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 16, borderTopWidth: 1, borderTopColor: '#ECECEC', marginTop: 12 },
  totalLabel: { color: '#111111', fontSize: 15, fontWeight: '800' },
  totalValue: { color: '#111111', fontSize: 26, fontWeight: '800' },
  earnsPoints: { color: '#999999', fontSize: 11, fontWeight: '700', marginTop: -8 },
});
