import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BarcodeScannerModal } from '@/components/barcode-scanner-modal';
import { Card } from '@/components/card';
import { CategoryChip } from '@/components/category-chip';
import { ProductModal } from '@/components/product-modal';
import { CheckoutPanel } from '@/components/checkout-panel';
import { CloseRegisterSheet } from '@/components/pos/close-register-sheet';
import { OpenRegisterSheet } from '@/components/pos/open-register-sheet';
import { RegisterBar, RegisterGate } from '@/components/pos/register-bar';
import { RegisterSessionDetail } from '@/components/register-session-detail';
import { DiscountEditor } from '@/components/discount-editor';
import { QuantityStepper } from '@/components/quantity-stepper';
import { ReceiptModal } from '@/components/receipt-modal';
import { ScanFeedbackBanner } from '@/components/scan-feedback-banner';
import { WedgeSink } from '@/components/wedge-sink';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useBarcodeWedge } from '@/hooks/use-barcode-wedge';
import { usePosSessionField } from '@/hooks/use-pos-session';
import { useRegisterSession } from '@/hooks/use-register-session';
import { useScannerSettings } from '@/hooks/use-scanner-settings';
import { barcodeCandidates, looksLikeBarcode, posScanOutcome, type ScanFeedback } from '@/lib/barcode';
import { listCashiers } from '@/lib/cashiers';
import { sessionCashSummary } from '@/lib/registers';
import { updateShop } from '@/lib/shops';
import { listStaff } from '@/lib/staff';
import { listCategories } from '@/lib/categories';
import { cartTotalCents } from '@/lib/cart';
import { confirmDestructive } from '@/lib/confirm';
import { listCurrencies } from '@/lib/currencies';
import { formatCents } from '@/lib/currency';
import { appliedPromotionForLine, cartSubtotalCents, discountAmountCents, lineDiscountCents, lineGrossCents } from '@/lib/discounts';
import { effectiveRedemption, maxRedeemablePoints, pointsEarnedFor, type LoyaltySettings } from '@/lib/loyalty';
import { hasMultipleLocations } from '@/lib/location-selection';
import { cashMovementsByCurrency, withDenomination } from '@/lib/register-sessions';
import { createProduct, findProductsByCode, listProducts } from '@/lib/products';
import { listPromotions } from '@/lib/promotions';
import { formatTodayHours, storeNameFor, type ReceiptData } from '@/lib/receipt';
import { completeSale } from '@/lib/sales';
import { taxCentsFor } from '@/lib/tax';
import type { Currency, Discount, NewProductInput, PaymentLine, PaymentMethod, Product, Promotion, StaffMember } from '@/types/models';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

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
  const { shop, can, locations, activeLocation, limitFor, usageOf, hasModule, myMembership, profile, refreshShop } = useAuth();
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
  // A completed sale hands off from the checkout sheet's modal to the receipt's,
  // and iOS will not present a modal while another is still mid-dismiss -- it
  // drops the presentation silently, so the sale went through and no receipt
  // ever appeared. The receipt therefore waits here until the sheet reports it
  // has finished dismissing (CheckoutPanel's `onDismiss`).
  //
  // iOS only, because only UIKit has that constraint: Android modals are
  // Dialogs and web's are plain DOM, neither of which can refuse, and RN fires
  // `onDismiss` on iOS alone -- so staging the receipt on those platforms would
  // wait for a signal that never comes and never show it at all.
  const stagesReceipt = Platform.OS === 'ios';
  const [pendingReceipt, setPendingReceipt] = useState<ReceiptData | null>(null);
  const showStagedReceipt = () => {
    if (!pendingReceipt) return;
    setReceipt(pendingReceipt);
    setPendingReceipt(null);
  };
  const [cashiers, setCashiers] = useState<string[]>([]);
  // The register this counter is on, if any. Fails soft to "nothing open",
  // which is exactly what a shop that has never set a register up sees.
  const { registers, session: registerSession, reload: reloadRegister } = useRegisterSession();
  const [team, setTeam] = useState<StaffMember[]>([]);
  const [registerSheet, setRegisterSheet] = useState<'open' | 'close' | 'handover' | 'detail' | null>(null);
  // Cash movements for the OPEN session only, so the close sheet can preview
  // the variance before the server's own figure comes back. Reset whenever the
  // session changes.
  const [sessionPayments, setSessionPayments] = useState<PaymentLine[]>([]);
  const [sessionSaleCount, setSessionSaleCount] = useState(0);
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

  // The roster, for the open sheet's person picker and the register bar's name.
  // Fails soft to an empty list: a cashier without staff.manage cannot read it,
  // and the sheets fall back to "you" and to `myMembership` when it is empty.
  useEffect(() => {
    if (!shop) return;
    let cancelled = false;
    listStaff(shop.id)
      .then((staff) => { if (!cancelled) setTeam(staff.filter((member) => member.active)); })
      .catch(() => { if (!cancelled) setTeam([]); });
    return () => { cancelled = true; };
  }, [shop]);

  // What this session has taken so far, so the close sheet can show a variance
  // the moment the count is entered rather than after a round trip.
  useEffect(() => {
    if (!registerSession) return;
    let cancelled = false;
    sessionCashSummary(registerSession.id)
      .then((summary) => {
        if (cancelled) return;
        setSessionPayments(summary.payments);
        setSessionSaleCount(summary.saleCount);
      })
      .catch(() => {
        if (!cancelled) { setSessionPayments([]); setSessionSaleCount(0); }
      });
    return () => { cancelled = true; };
  }, [registerSession, receipt]);
  // Coming back to this screen on a phone, where the tab shell never unmounted
  // it, so its data is as old as the last time it was looked at.
  useRefreshOnFocus(reload);
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

  // Safety net for the staged receipt above, NOT the mechanism -- `onDismiss` is
  // what normally promotes it, and normally wins this race by a wide margin.
  // This exists because the failure it guards against is losing a paid sale's
  // receipt entirely: if `onDismiss` ever fails to fire (a sheet already closed
  // when the sale completed, so there was no dismissal to report), the cashier
  // would be left with money taken and nothing to hand over. Showing the
  // receipt slightly late is always better than not at all.
  useEffect(() => {
    if (!pendingReceipt) return;
    const timer = setTimeout(() => {
      setReceipt(pendingReceipt);
      setPendingReceipt(null);
    }, 700);
    return () => clearTimeout(timer);
  }, [pendingReceipt]);

  // The register's own person is who is serving, so the receipt should say so
  // without anyone re-picking it. Only ever fills a BLANK selection — a cashier
  // who deliberately picked a different name keeps it.
  const sessionMember = team.find((member) => member.id === registerSession?.shopMemberId) ?? null;
  useEffect(() => {
    if (!sessionMember?.fullName) return;
    setCashierName((current) => current ?? sessionMember.fullName);
  }, [sessionMember, setCashierName]);

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
      // The new sale's id, which the receipt needs for its code and QR.
      // `completeSale` has always returned it; this path used to drop it on the
      // floor because nothing downstream asked for one.
      const saleId = await completeSale(
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
        redemption.points,
        registerSession?.id ?? null
      );
      const completed: ReceiptData = {
        saleId,
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
        // This branch's mobile-money numbers, printed only under the payment
        // line that used them.
        zaadMerchantId: activeLocation.zaadMerchantId,
        edahabMerchantId: activeLocation.edahabMerchantId,
        returnPolicy: shop.returnPolicy,
        showKaiibiBranding: !hasModule('receipt_branding_removal'),
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
      };
      // Emptying the cart below is what closes the checkout sheet, so on iOS the
      // receipt is staged and presented from the sheet's `onDismiss` instead --
      // presenting it here would race that dismissal and be dropped.
      if (stagesReceipt) setPendingReceipt(completed);
      else setReceipt(completed);
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
  // On mobile the cart list is a plain View, for exactly the reason the note
  // above gives: it was a nested, flex-sized ScrollView capped at 240px, which
  // is the sizing fight that note describes, and it left a tall band of dead
  // page between the checkout button and the product grid.
  //
  // The cap it used to carry was meant to keep the total reachable. It is not
  // needed here — the cart renders ABOVE the browse pane on a phone, so the
  // total is already near the top of the page rather than beyond a long list.
  const CartList = compact ? View : ScrollView;
  const cartListProps = compact ? {} : { style: styles.cartList };

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
        <CategoryChip variant="bento" label="All" active={category === null} onPress={() => setCategory(null)} />
        {categories.map((item) => (
          <CategoryChip variant="bento" key={item} label={item} color={categoryColors.get(item)} active={category === item} onPress={() => setCategory(item)} />
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

  // A shop that requires an open register gets a refusal in place of the cart.
  // The product grid stays browsable behind it on purpose: answering "do you
  // have it in stock?" is harmless, and the cashier can keep serving while a
  // supervisor walks over with the float.
  const registerBlocks = (activeLocation?.requireOpenRegister ?? false) && !registerSession;

  const cartPaneEl = (
    <View style={[styles.cartPane, compact && styles.cartPaneCompact]}>
      {registerBlocks && <RegisterGate onOpen={() => setRegisterSheet('open')} />}
      {/* The whole sale is ONE card floating on the grey page — it used to be a
          white column with a hairline down its left edge, which read as a
          second page rather than as the thing being built. */}
      {!registerBlocks && (
      <Card variant="bento" style={[styles.cartCard, compact && styles.cartCardCompact]}>
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
      <CartList {...cartListProps}>
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
      </CartList>
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
          // The sheet is fully gone, so it's now safe to present the receipt.
          // A no-op when nothing is staged, which is every dismissal that
          // wasn't a completed sale (the cashier tapping Close).
          onDismiss={showStagedReceipt}
        />
      )}
      </Card>
      )}
    </View>
  );

  // Keeping a note the cashier just met writes a shop setting, so it is offered
  // only to someone who may edit settings. Everyone can still COUNT with the
  // note — this is about whether it survives to tomorrow.
  const rememberNote = can('settings.access')
    ? async (currencyCode: string, minor: number) => {
        if (!shop) return;
        const next = withDenomination(shop.cashDenominations, currencyCode, minor);
        if (next === shop.cashDenominations) return;
        try {
          await updateShop(shop.id, { cashDenominations: next });
          await refreshShop();
        } catch {
          // Silent on purpose: the note still works for this count, and a
          // failure to remember it is not worth interrupting a drawer count.
        }
      }
    : undefined;

  const sessionsByRegister = registerSession ? { [registerSession.registerId]: registerSession } : {};
  // Read through the session rather than cleared when it ends: a closed session
  // leaves its last summary in state, and gating here is one condition instead
  // of a synchronous setState on every close.
  const livePayments = registerSession ? sessionPayments : [];
  const sessionCashMovements = cashMovementsByCurrency(livePayments);
  const nonCashTotals = (['zaad', 'edahab', 'other'] as const)
    .map((method) => ({
      label: method === 'zaad' ? 'ZAAD' : method === 'edahab' ? 'e-Dahab' : 'Other',
      cents: livePayments.filter((p) => p.method === method).reduce((sum, p) => sum + p.amountCents, 0),
    }))
    .filter((total) => total.cents > 0);

  const registerBarEl = (
    <RegisterBar
      registers={registers}
      session={registerSession}
      register={registers.find((r) => r.id === registerSession?.registerId) ?? null}
      member={sessionMember ?? myMembership}
      fallbackName={profile?.fullName}
      saleCount={sessionSaleCount}
      takenCents={livePayments.reduce((sum, payment) => sum + payment.amountCents, 0)}
      onOpen={() => setRegisterSheet('open')}
      onClose={() => setRegisterSheet('close')}
      onHandover={() => setRegisterSheet('handover')}
      onShowDetail={() => setRegisterSheet('detail')}
    />
  );

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <View style={styles.registerBarWrap}>{registerBarEl}</View>
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
      {shop && registerSheet === 'open' && (
        <OpenRegisterSheet
          registers={registers}
          sessionsByRegister={sessionsByRegister}
          team={team}
          myMembership={myMembership}
          fallbackName={profile?.fullName}
          canManageRegisters={can('registers.manage')}
          currencies={currencies}
          denominations={shop.cashDenominations}
          onRememberNote={rememberNote}
          onClose={() => setRegisterSheet(null)}
          onOpened={reloadRegister}
          onRegistersChanged={reloadRegister}
        />
      )}
      {registerSession && registerSheet === 'detail' && (
        <RegisterSessionDetail
          key={registerSession.id}
          sessionId={registerSession.id}
          registerName={registers.find((r) => r.id === registerSession.registerId)?.name ?? 'Register'}
          registerNote={registers.find((r) => r.id === registerSession.registerId)?.note ?? null}
          nameFor={(session) => {
            const onIt = team.find((member) => member.id === session.shopMemberId);
            return onIt?.fullName ?? onIt?.email ?? (session.shopMemberId ? 'Staff' : profile?.fullName ?? 'The owner');
          }}
          currencies={currencies}
          onClose={() => setRegisterSheet(null)}
        />
      )}
      {shop && registerSession && (registerSheet === 'close' || registerSheet === 'handover') && (
        <CloseRegisterSheet
          key={`${registerSession.id}-${registerSheet}`}
          mode={registerSheet}
          session={registerSession}
          register={registers.find((r) => r.id === registerSession.registerId) ?? null}
          member={sessionMember ?? myMembership}
          fallbackName={profile?.fullName}
          team={team}
          currencies={currencies}
          denominations={shop.cashDenominations}
          onRememberNote={rememberNote}
          cashMovements={sessionCashMovements}
          saleCount={sessionSaleCount}
          nonCashTotals={nonCashTotals}
          onClose={() => setRegisterSheet(null)}
          onDone={reloadRegister}
        />
      )}
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
  // The counter is a workspace, not a page of cards: the two panes are the
  // layout, and the bento surfaces are what they are painted in.
  safeArea: { flex: 1, backgroundColor: theme.bentoPage },
  // Above both panes, so the bar gets the whole width and keeps its labels.
  registerBarWrap: { paddingHorizontal: 14, paddingTop: 14 },
  split: { flex: 1, flexDirection: 'row' },
  splitCompact: { flex: 1, flexDirection: 'column' },
  splitCompactContent: { flexDirection: 'column', width: '100%', minWidth: 0 },
  browsePane: { flex: 2, padding: 18 },
  browsePaneCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0, padding: 16, paddingBottom: 10 },
  // The gap below lives on the wrapper, not the input: the scan button is
  // absolutely positioned and centred by this, so a margin on the field would
  // push it below the field's real centre.
  searchWrap: { position: 'relative', justifyContent: 'center', marginBottom: 14 },
  searchIcon: { position: 'absolute', left: 16, color: theme.bentoMuted2, fontSize: 18, zIndex: 1 },
  // White with a firm edge, like the cards — an input is a surface you act on,
  // and a soft grey field disappears into the grey page.
  search: {
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 14,
    height: 52,
    paddingLeft: 42,
    paddingRight: 54,
    fontSize: 15,
    color: theme.bentoInk,
  },
  categoryScroll: { flexGrow: 0, flexShrink: 0 },
  categoryRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 16 },
  categoryScrollCompact: { flexGrow: 0, flexShrink: 0 },
  categoryRowCompact: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  gridCompact: { gap: 8 },
  gridScrollCompact: { flexGrow: 0, flexShrink: 0 },
  // Tiles keep a border while the panels float. This is the one screen read at
  // arm's length in shop lighting, and the tile carries the most information
  // per pixel in the app -- a visible edge is worth more here than the cleaner
  // borderless look the desk screens get.
  gridTile: {
    flexBasis: '31%',
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 190,
    backgroundColor: theme.bentoSurface,
    borderRadius: BENTO_RADIUS_TILE,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.bentoLine,
  },
  gridTileCompact: { flexBasis: '31%', minWidth: 90, flexGrow: 0, flexShrink: 0, borderRadius: 12, padding: 8 },
  gridTileDisabled: { opacity: 0.45 },
  gridThumb: { width: '100%', aspectRatio: 1, borderRadius: 12, marginBottom: 12 },
  gridThumbCompact: { aspectRatio: 1.3, borderRadius: 8, marginBottom: 6 },
  gridThumbPlaceholder: { backgroundColor: theme.bentoSoft, alignItems: 'center', justifyContent: 'center' },
  // A teardrop silhouette built from a rotated square with three rounded
  // corners — avoids pulling in an icon/SVG library just for one glyph, and
  // (unlike the 💧 emoji) its color is fully controllable to match the
  // monochrome palette and dim for out-of-stock items.
  gridThumbDrop: {
    width: 30,
    height: 30,
    backgroundColor: theme.bentoInk,
    borderTopLeftRadius: 15,
    borderTopRightRadius: 15,
    borderBottomRightRadius: 15,
    borderBottomLeftRadius: 0,
    transform: [{ rotate: '-45deg' }],
  },
  gridThumbDropCompact: { width: 16, height: 16, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomRightRadius: 8 },
  gridThumbDropMuted: { backgroundColor: theme.bentoMuted2 },
  gridBrand: { color: theme.bentoMuted2, fontSize: 10, fontWeight: '800', letterSpacing: 0.9 },
  gridBrandCompact: { fontSize: 8 },
  gridName: { color: theme.bentoInk, fontSize: 14, fontWeight: '700', minHeight: 38, marginTop: 3, lineHeight: 18 },
  gridNameCompact: { fontSize: 11, minHeight: 15, marginTop: 2, lineHeight: 14 },
  gridFooter: { marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' },
  gridFooterCompact: { marginTop: 5, flexDirection: 'column', alignItems: 'flex-start', gap: 2 },
  gridPrice: { color: theme.bentoInk, fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'] },
  gridPriceCompact: { fontSize: 13 },
  gridStock: { color: theme.bentoMuted, fontSize: 11.5 },
  gridStockCompact: { fontSize: 9 },
  gridStockWithBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  // Warm on purpose: a low-stock flag is SUPPOSED to sit warmer than the
  // cool-grey around it.
  stockPill: { fontSize: 10, fontWeight: '800', color: '#8A530F', backgroundColor: '#FDF1E3', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 999, alignSelf: 'flex-start', overflow: 'hidden' },
  stockPillCompact: { fontSize: 8, paddingVertical: 2, paddingHorizontal: 6 },

  // ---- cart: one card, sitting on the page like every other card ----
  cartPane: { flex: 1, padding: 18, paddingLeft: 4, minWidth: 340 },
  cartPaneCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0, padding: 16, paddingBottom: 0 },
  cartCard: { flex: 1, padding: 16 },
  // Spelled out rather than `flex: 0`, matching the panes above: inside the
  // page's vertical scroller the card must size to its content, and a bare
  // `flex: 0` leaves flexBasis to interpretation.
  cartCardCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  cartTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 },
  cartTitleActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cartTitle: { color: theme.bentoInk, fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  miniButton: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 11 },
  miniButtonText: { color: theme.bentoInk2, fontSize: 11.5, fontWeight: '700' },
  // Black and larger than its neighbour: scanning is how a basket actually
  // gets built, and this is the one scan control still in reach once the phone
  // has pushed the search field below the cart. Clear all stays quiet beside
  // it -- two black pills would make "wipe the sale" look equally inviting.
  scanCartButton: { backgroundColor: theme.bentoInk, borderWidth: 1, borderColor: theme.bentoInk, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 16 },
  scanCartButtonText: { color: theme.bentoSurface, fontSize: 13.5, fontWeight: '800' },
  clearAll: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 14 },
  clearAllText: { color: theme.bentoInk2, fontSize: 12.5, fontWeight: '700' },
  // Bigger than Inventory's, and black: scanning is the fastest way to find a
  // product here, and this is pressed at a counter rather than at a desk.
  scanInSearch: { position: 'absolute', right: 6, height: 40, width: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bentoInk },
  scanInSearchText: { fontSize: 17, lineHeight: 17, color: theme.bentoSurface, includeFontPadding: false, textAlignVertical: 'center' },
  addFromScan: { backgroundColor: theme.bentoInk, borderRadius: 999, paddingHorizontal: 15, paddingVertical: 11, marginBottom: 14, alignSelf: 'flex-start' },
  addFromScanText: { color: theme.bentoSurface, fontSize: 12, fontWeight: '800' },
  cartList: { flex: 1 },
  emptyWrap: { alignItems: 'center', marginTop: 40, marginBottom: 24 },
  emptyIcon: { fontSize: 30, marginBottom: 10, opacity: 0.5 },
  empty: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  // A ruled row, not a nested grey card: a card inside a card at every line
  // made the basket read as a stack of panels rather than as a list.
  cartLine: { paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: theme.bentoRule },
  cartLineRow: { flexDirection: 'row', alignItems: 'center' },
  cartLineName: { color: theme.bentoInk, fontSize: 13.5, fontWeight: '700' },
  cartLinePriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  cartLinePrice: { color: theme.bentoMuted, fontSize: 12 },
  cartLinePriceStruck: { color: theme.bentoMuted2, fontSize: 12, textDecorationLine: 'line-through' },
  cartLinePromo: { color: theme.bentoProfit, fontSize: 11, fontWeight: '700', marginTop: 4 },
  cartLineDiscountToggle: { color: theme.bentoMuted, fontSize: 11.5, fontWeight: '700', marginTop: 6, textDecorationLine: 'underline' },
  discountSection: { marginTop: 4 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  summaryLabel: { color: theme.bentoMuted, fontSize: 13 },
  summaryValue: { color: theme.bentoInk, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  // Green, not red: money coming OFF the customer's bill is good news for them,
  // and it carries a signed figure so the colour is never the only signal.
  summaryValueDiscount: { color: theme.bentoProfit, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  // The one loud thing on the screen. This is the number said out loud to the
  // customer and the one that gets a sale wrong if it is misread, so it does
  // not share a size with "Subtotal".
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 12, borderTopWidth: 2, borderTopColor: theme.bentoInk, marginTop: 10 },
  totalLabel: { color: theme.bentoInk, fontSize: 15, fontWeight: '800' },
  totalValue: { color: theme.bentoInk, fontSize: 30, fontWeight: '800', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  earnsPoints: { color: theme.bentoMuted, fontSize: 11.5, fontWeight: '700', marginTop: 6 },
});
