import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BarcodeScannerModal } from '@/components/barcode-scanner-modal';
import { CategoryChip } from '@/components/category-chip';
import { OptionPicker } from '@/components/option-picker';
import { ProductModal } from '@/components/product-modal';
import { CheckoutPanel, CustomerBlock, PaymentBlock } from '@/components/checkout-panel';
import type { SelectedCustomer } from '@/components/customer-picker';
import { CloseRegisterSheet } from '@/components/pos/close-register-sheet';
import { DualAmount } from '@/components/pos/dual-amount';
import { HeldOrdersMenu } from '@/components/pos/held-orders-menu';
import { SaleLine } from '@/components/pos/sale-line';
import { CustomerBalanceRow } from '@/components/pos/customer-balance-row';
import { RestChoice } from '@/components/pos/rest-choice';
import { SalePanel } from '@/components/pos/sale-panel';
import { OpenRegisterSheet } from '@/components/pos/open-register-sheet';
import { RegisterBar, RegisterGate } from '@/components/pos/register-bar';
import { RegisterSessionDetail } from '@/components/register-session-detail';
import { DiscountEditor } from '@/components/discount-editor';
import { QuantityStepper } from '@/components/quantity-stepper';
import { ReceiptModal } from '@/components/receipt-modal';
import { ScanFeedbackBanner } from '@/components/scan-feedback-banner';
import { SearchKeypad } from '@/components/search-keypad';
import { SearchRow, useSearchKeypadState } from '@/components/search-row';
import { TillKeyboardNotice } from '@/components/till-keyboard-notice';
import { WedgeSink } from '@/components/wedge-sink';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { BENTO_RADIUS, BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useBarcodeWedge, useWedgeSinkFallback } from '@/hooks/use-barcode-wedge';
import { usePosSessionField } from '@/hooks/use-pos-session';
import { useRegisterSession } from '@/hooks/use-register-session';
import { useScannerSettings } from '@/hooks/use-scanner-settings';
import { useKeypadProven } from '@/lib/keypad-proof';
import { barcodeCandidates, looksLikeBarcode, posScanOutcome, type ScanFeedback } from '@/lib/barcode';
import { listCashiers } from '@/lib/cashiers';
import { openSessionAt, sessionCashSummary } from '@/lib/registers';
import { updateShop } from '@/lib/shops';
import { listStaff } from '@/lib/staff';
import { listCategories } from '@/lib/categories';
import { cartTotalCents } from '@/lib/cart';
import { checkoutErrorMessage, extractErrorMessage, isClosedRegisterError } from '@/lib/checkout-errors';
import { allocate, customerBalance, settleBalance, type CustomerBalance } from '@/lib/balances';
import { checkoutIntent } from '@/lib/checkout-intent';
import { confirmDestructive } from '@/lib/confirm';
import { holdOrder, readHeldOrders, resumeHeldOrder, type HeldOrder } from '@/lib/held-orders';
import { listCurrencies } from '@/lib/currencies';
import { formatCents } from '@/lib/currency';
import { displayCurrency, secondaryAmount } from '@/lib/display-currency';
import { appliedPromotionForLine, bestPromotionForProduct, cartSubtotalCents, discountAmountCents, lineDiscountCents, lineGrossCents } from '@/lib/discounts';
import { effectiveRedemption, maxRedeemablePoints, pointsEarnedFor, type LoyaltySettings } from '@/lib/loyalty';
import { hasMultipleLocations } from '@/lib/location-selection';
import { cashMovementsByCurrency, withDenomination } from '@/lib/register-sessions';
import { createProduct, findProductsByCode, listProducts } from '@/lib/products';
import { listPromotions } from '@/lib/promotions';
import { formatTodayHours, storeNameFor, type ReceiptData } from '@/lib/receipt';
import { completeSale } from '@/lib/sales';
import { taxCentsFor } from '@/lib/tax';
import type { CartLine, Currency, Discount, NewProductInput, PaymentLine, PaymentMethod, Product, Promotion, StaffMember } from '@/types/models';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

type CustomerBalanceState = { owedCents: number; oldest: CustomerBalance | null; sales: CustomerBalance[] };

// A customer who owes nothing. A stable module-level constant rather than a
// fresh object each render, so nothing downstream re-runs on identity alone.
const NO_BALANCE: CustomerBalanceState = { owedCents: 0, oldest: null, sales: [] };

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
  // Whether the uncovered part of the bill is being carried on the customer's
  // account. Off by default and off again on every basket change: taking the
  // money is the ordinary path, and this is the deliberate departure from it.
  const [payLater, setPayLater] = useState(false);
  // The customer picker's open state, held here so the pay-later control can
  // open it. Without that, "attach a customer" was an instruction with nowhere
  // to follow it to.
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  // What the attached customer already owed before this basket, stored WITH the
  // customer it was read for. Keyed rather than cleared on change: a balance
  // shown against the wrong name is worse than none, and deriving it means
  // there is no window in which the previous customer's debt is on screen.
  const [fetchedBalance, setFetchedBalance] = useState<{ customerId: string; data: CustomerBalanceState } | null>(null);
  const balance: CustomerBalanceState =
    fetchedBalance && fetchedBalance.customerId === selectedCustomer?.id ? fetchedBalance.data : NO_BALANCE;
  // Which customer the cashier asked to collect from, not an amount. The amount
  // is always today's owed figure, so it cannot go stale against a balance
  // another till just moved.
  const [settlingFor, setSettlingFor] = useState<string | null>(null);
  const settlingCents = settlingFor && settlingFor === selectedCustomer?.id ? balance.owedCents : 0;
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
  // The shop's second currency, resolved once per render and passed down, so a
  // tile, a cart line and the total can never echo different rates.
  const secondCurrency = displayCurrency(currencies);
  // Height of a single compact grid tile, measured from the first rendered
  // tile — rows stretch every tile to match the tallest in that row, so this
  // doubles as the row height. Used to cap the mobile product grid at 2 rows.
  const [compactTileHeight, setCompactTileHeight] = useState<number | null>(null);
  // The result of the last scan. Deliberately transient (see the clearing
  // effect below): a cashier scanning a basket needs to glance at the outcome,
  // not dismiss a notice per item.
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  // The checkout sheet. Owned here rather than inside CheckoutPanel, because
  // the panel's primary button, the "Served by" row and a completed sale all
  // need to open or close the same one.
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  // The cashier chooser on a counter, where there is no sheet to hold it.
  const [servedByOpen, setServedByOpen] = useState(false);
  // Sales parked at this till, read from storage so they survive a force-quit.
  const [heldOrders, setHeldOrders] = useState<HeldOrder[]>([]);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const scanner = useScannerSettings();
  const { keypadOpen, setKeypadOpen } = useSearchKeypadState(scanner.onScreenKeypad);
  // Old binaries only. See `useWedgeSinkFallback`.
  const sinkFallback = useWedgeSinkFallback();
  // The old keypad stands down only once the new dock has been seen working on
  // this device -- never on a claim that it could.
  const universalKeypad = useKeypadProven();
  const splitRef = useRef<ScrollView>(null);
  // Compact POS puts the cart ABOVE the browse pane, so the search row's
  // content-relative y is the pane's y plus the row's y within the pane.
  const browsePaneY = useRef(0);
  const searchRowY = useRef(0);
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

  // Parked sales belong to a person at a counter, so both scope the read.
  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    readHeldOrders(profile.id, activeLocation?.id ?? null)
      .then((orders) => { if (!cancelled) setHeldOrders(orders); })
      .catch(() => { if (!cancelled) setHeldOrders([]); });
    return () => { cancelled = true; };
  }, [profile, activeLocation]);

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
  // Loaded once per shop change, but the server now rejects a stale promotion
  // id (paused/archived/deleted since this list was fetched), so a launch-only
  // load left every sale touching that product refused until a force-quit.
  // Refreshed on focus, same mechanism as `reload` above for products, plus
  // once more right after a sale completes.
  const reloadPromotions = useCallback(async () => {
    if (!shop) return;
    try {
      setPromotions(await listPromotions(shop.id));
    } catch {
      // Soft-fail like the original load: an empty/stale list just means
      // fewer offers show up, not a broken screen.
    }
  }, [shop]);
  useEffect(() => { reloadPromotions(); }, [reloadPromotions]);
  useRefreshOnFocus(reloadPromotions);
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
    // Same rule as Inventory: the offer to create a product belongs to the scan
    // that raised it, and nothing else on this screen clears it.
    setUnknownCode(null);

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
  // `submitted` rather than `search`: on the scan path the row has just
  // replaced the field, and this runs in the same tick as that replacement.
  const handleSearchSubmit = async (submitted: string) => {
    const raw = submitted.trim();
    if (!raw || !scanner.resolveCodes) return;
    const outcome = posScanOutcome(products, cart, raw);
    // Someone searching for "toner" and pressing Enter is not a failed scan.
    // Staying silent here is what keeps the box feeling like a search box.
    if (outcome.kind === 'unknown' && !looksLikeBarcode(raw)) return;
    const handled = await handleScannedCode(raw);
    // Clear only on a hit: an unrecognised code stays so it can be read and
    // corrected. It is safe to leave now that the next scan REPLACES the field
    // rather than being appended to it (see `stepFieldBurst`).
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

  // The clock the GRID prices against, which is not the cart's. The cart pins
  // its clock when the sale starts so a price cannot move mid-basket; a tile is
  // browsing, and wants to stop advertising an offer whose window has closed.
  // Held in state rather than read from Date.now() during render -- that is an
  // impure call, and it re-runs every time anything on the screen changes.
  const [browseClock, setBrowseClock] = useState(() => Date.now());
  useRefreshOnFocus(useCallback(async () => { setBrowseClock(Date.now()); }, []));

  // One clock for one transaction. Every discount function takes an optional
  // `now`, and left to default they each call Date.now() independently -- so a
  // promotion whose window closes between the render that showed the total and
  // the submit that builds the payload makes the two disagree, and the server
  // refuses the sale with a payments-versus-total mismatch at the worst
  // possible moment. Pinning it when the cart starts means a sale is priced as
  // of when it began, which is also what a customer standing at the counter
  // assumes. Reset when the cart empties, so the next sale reprices.
  //
  // Assigned during render rather than in an effect: an effect would run after
  // a first paint that had already priced the line with a different clock.
  const pricedAtRef = useRef<number | null>(null);
  if (cart.length === 0) pricedAtRef.current = null;
  else if (pricedAtRef.current === null) pricedAtRef.current = Date.now();
  const pricingNow = pricedAtRef.current ?? Date.now();

  const grossCents = cartTotalCents(cart);
  const subtotalCents = cartSubtotalCents(cart, promotions, pricingNow);
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
  // Goods plus whatever of an older account is being cleared in the same
  // breath. `fullyPaid` is against this, not the basket, or a cashier taking
  // $34.74 off an account with an empty till is told the payment is short.
  const dueCents = total + settlingCents;
  const fullyPaid = payments.length > 0 && paidCents === dueCents;
  // Only offered while there is a shortfall AND a basket to carry it: settling
  // an old account is not itself a thing you can half-do on credit.
  const restCents = Math.max(0, dueCents - paidCents);
  const canOfferCredit = cart.length > 0 && restCents > 0;
  const leavingBalance = canOfferCredit && payLater && Boolean(selectedCustomer);

  // Any cart change invalidates whatever's already been entered in the
  // payment picker (the amounts no longer sum to the new total), so clear
  // it rather than let a stale split silently under/over-cover the sale.
  useEffect(() => { setPayments([]); }, [total, setPayments]);

  // "Pay later" is a decision about one specific shortfall. Change the basket
  // and that shortfall is a different number, so the choice goes back to the
  // safe one rather than silently carrying over onto a bill nobody agreed to.
  //
  // Adjusted during render rather than in an effect, which is what react-compiler
  // asks for and what search-row.tsx's keypad state already does: an effect here
  // would paint one frame with the old choice against the new total.
  const [choiceSetForTotal, setChoiceSetForTotal] = useState(total);
  if (choiceSetForTotal !== total) {
    setChoiceSetForTotal(total);
    setPayLater(false);
  }

  // What this customer already owed. Fetch only -- nothing is cleared here,
  // because `balance` above is derived from whether the stored read still
  // belongs to the attached customer.
  useEffect(() => {
    const shopId = shop?.id;
    const customerId = selectedCustomer?.id;
    if (!shopId || !customerId) return;
    let cancelled = false;
    customerBalance(shopId, customerId)
      .then((next) => { if (!cancelled) setFetchedBalance({ customerId, data: next }); })
      // Failing soft: a till that cannot read an old balance must still be able
      // to sell. The server refuses an overshoot anyway, so the worst case is
      // the cashier not being offered a settlement they could have taken.
      .catch(() => { if (!cancelled) setFetchedBalance({ customerId, data: NO_BALANCE }); });
    return () => { cancelled = true; };
  }, [shop?.id, selectedCustomer?.id]);

  // `retryOnSession` is set only by the closed-register recovery below, which
  // is also what stops it recursing: a second refusal is reported, not retried.
  //
  // Every call site wraps this in an arrow. A Pressable hands its handler the
  // press event, which would arrive here as a register session id and be sent
  // to the server -- Supabase then fails on the circular structure rather than
  // on anything to do with the sale.
  // One sentence, shared by the panel and the sheet, so the two surfaces can
  // never disagree about what the next tap does.
  const intent = checkoutIntent({
    cartEmpty: cart.length === 0,
    totalCents: total,
    payments,
    customerName: selectedCustomer?.name ?? null,
    submitting,
    secondaryTotal: secondaryAmount(total, secondCurrency),
    restOwed: canOfferCredit && payLater,
    settlingCents,
  });

  // Taking money off an older sale. Its own path, not a variant of the sale
  // one: nothing is being sold, no stock moves, and the money lands on sales
  // that were rung up days ago.
  //
  // Sequentially, never in parallel: each call takes a row lock and re-reads
  // what is owed, so two at once against the same customer would both be
  // allowed the same shortfall.
  const settleOlderBalance = async () => {
    if (!shop || balance.sales.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      for (const step of allocate(payments, balance.sales)) {
        await settleBalance(step.saleId, step.payments, registerSession?.id ?? null);
      }
      setPayments([]);
      setSettlingFor(null);
      // Re-read rather than subtract locally: a refund or another till may have
      // moved this account while the cashier was counting the cash.
      if (selectedCustomer?.id) {
        const customerId = selectedCustomer.id;
        const next = await customerBalance(shop.id, customerId).catch(() => NO_BALANCE);
        setFetchedBalance({ customerId, data: next });
      }
      await reload();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const checkout = async (retryOnSession?: string) => {
    if (!shop) return;
    // Nothing in the basket means this tap is about an older account, not a
    // sale. `intent` has already decided whether it is allowed to fire.
    if (cart.length === 0) {
      if (settlingCents > 0 && intent.enabled) await settleOlderBalance();
      return;
    }
    if (!fullyPaid && !leavingBalance) return;
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
        retryOnSession ?? registerSession?.id ?? null,
        pricingNow,
        leavingBalance
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
          discountCents: lineDiscountCents(line, promotions, pricingNow),
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
        // What the customer is walking out still owing on THIS sale. The total
        // above is unchanged -- it is what the goods came to, and it does not
        // move because they have not finished paying for them.
        balanceDueCents: leavingBalance ? Math.max(0, total - paidCents) : 0,
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
      // Clearing the customer above empties the balance through the effect that
      // watches them; these two are reset here as well so the next sale starts
      // from the safe choice even if the same customer is picked straight back.
      setPayLater(false);
      setSettlingFor(null);
      setEditingTransactionDiscount(false);
      setEditingLineDiscount(null);
      await reload();
      // A promotion can be paused/archived by someone else between two sales
      // on this till; re-fetching here keeps the next sale's list current
      // without waiting for a refocus.
      await reloadPromotions();
    } catch (err) {
      const message = extractErrorMessage(err);
      // The till this sale was going to be filed against was closed underneath
      // it -- by a supervisor, by another device, or by the same person on
      // another tab. Nothing was written, so the sale can simply be filed
      // against whichever register is open NOW rather than leaving a cashier
      // holding a basket they cannot sell.
      if (isClosedRegisterError(message) && !retryOnSession && activeLocation) {
        const open = await openSessionAt(activeLocation.id).catch(() => null);
        await reloadRegister();
        if (open && open.id !== registerSession?.id) {
          setError(null);
          setSubmitting(false);
          await checkout(open.id);
          return;
        }
        setError(checkoutErrorMessage(err, cart, promotions, pricingNow));
        return;
      }
      // The server refused because an offer moved out of its window. Saying so
      // is not enough: this screen's promotions were loaded when it mounted, so
      // the cart is still priced by the old ones and every retry is refused the
      // same way -- the cashier is stuck until they restart the app. Refetching
      // reprices the cart, and the payment collected against the old total has
      // to go with it, or "fully paid" stays true at the wrong number.
      if (/promotion .* (has ended|has not started yet)/.test(message)) {
        const fresh = await listPromotions(shop.id).catch(() => null);
        const wasCents = total;
        if (fresh) setPromotions(fresh);
        setPayments([]);
        pricedAtRef.current = Date.now();
        setError(
          `An offer changed while you were ringing this up, so ${formatCents(wasCents)} is no longer the price. The cart has been updated — take the payment again.`
        );
      } else {
        setError(checkoutErrorMessage(err, cart, promotions, pricingNow));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Park the whole sale -- basket, customer, discount, points -- and hand the
  // till back empty for the next person in the queue. The cashier stays: they
  // are still the one serving.
  const holdCurrentSale = async () => {
    if (!profile || cart.length === 0) return;
    const orders = await holdOrder(profile.id, activeLocation?.id ?? null, {
      cart,
      customer: selectedCustomer,
      transactionDiscount,
      pointsRedeemed,
      totalCents: total,
      itemCount: cart.reduce((sum, line) => sum + line.quantity, 0),
    });
    setHeldOrders(orders);
    setCart([]);
    setPayments([]);
    setSelectedCustomer(null);
    setTransactionDiscount(null);
    setPointsRedeemed(0);
    setEditingTransactionDiscount(false);
    setEditingLineDiscount(null);
  };

  const resumeSale = async (id: string) => {
    if (!profile) return;
    // A basket already on the till is not in anyone's way -- it is someone's
    // shopping. Park it before loading the other one, so recalling a sale can
    // never be the thing that loses one. Both then sit in the queue together.
    if (cart.length > 0) await holdCurrentSale();
    const { order, remaining } = await resumeHeldOrder(profile.id, activeLocation?.id ?? null, id);
    setHeldOrders(remaining);
    if (!order) return;
    // A parked basket reserves nothing, so an hour later the shelf may have
    // moved. Say which lines cannot be filled NOW rather than letting the
    // cashier find out from a refused charge with a customer waiting.
    const short = order.cart.filter((line) => {
      const onHand = products.find((product) => product.id === line.product.id)?.stock ?? line.product.stock;
      return onHand < line.quantity;
    });
    if (short.length > 0) {
      setScanFeedback({
        tone: 'warn',
        message: `Stock has moved since this was held: ${short.map((line) => line.product.name).join(', ')}. Check before charging.`,
      });
    }
    setCart(order.cart);
    setSelectedCustomer(order.customer);
    setTransactionDiscount(order.transactionDiscount);
    setPointsRedeemed(order.pointsRedeemed);
    // Whatever was entered against the old total is meaningless against this
    // one, which is being repriced as it lands.
    setPayments([]);
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
  // On a phone the list scrolls inside a capped height rather than growing the
  // page. An uncapped list looks fine at two lines and fails at seven: the
  // subtotal, the total and the button that acts on them are pushed off the
  // bottom, so the last thing a cashier does on every sale is scroll past the
  // whole basket to reach Checkout.
  //
  // The cap is an explicit pixel height, NOT a flex size -- which is the same
  // exception the product grid above already makes, and the reason it escapes
  // the nested-scroller sizing fight the note there describes.
  const CartList = ScrollView;
  const cartListProps = compact
    ? { style: styles.cartListCompact, contentContainerStyle: styles.cartListContent, nestedScrollEnabled: true }
    : { style: styles.cartList, contentContainerStyle: styles.cartListContent };

  // Units sitting in parked baskets at THIS till. Held stock is not reserved --
  // nothing is deducted until complete_sale runs -- so the grid keeps showing
  // the real figure and names the parked units beside it. A cashier who knows
  // three of the five are promised to someone else can decide for themselves;
  // a silently reduced number would be a lie in the other direction.
  const heldUnits = new Map<string, number>();
  heldOrders.forEach((order) => {
    order.cart.forEach((line) => {
      heldUnits.set(line.product.id, (heldUnits.get(line.product.id) ?? 0) + line.quantity);
    });
  });

  const browsePaneEl = (
    <View
      style={[styles.browsePane, compact && styles.browsePaneCompact]}
      onLayout={(e) => { browsePaneY.current = e.nativeEvent.layout.y; }}
    >
      <TillKeyboardNotice />

      <View style={[styles.browseCard, compact && styles.browseCardCompact]}>
      <View onLayout={(e) => { searchRowY.current = e.nativeEvent.layout.y; }}>
        <SearchRow
          value={search}
          onChange={setSearch}
          onSubmit={handleSearchSubmit}
          placeholder="Search or scan a product"
          // Legacy binaries only -- see the note on Inventory's copy. Where the
          // dock can type into the focused field, this is an ordinary text box.
          useKeypad={scanner.onScreenKeypad && !universalKeypad}
          showScanButton={scanner.camera}
          onScanPress={() => setScannerOpen(true)}
          showSearchIcon
          size="counter"
          keypadOpen={keypadOpen}
          onKeypadOpenChange={(open) => {
            setKeypadOpen(open);
            // `scrollTo` exists only when Split is the compact ScrollView; on
            // wide layouts nothing scrolls and the row is always visible.
            if (open && compact) splitRef.current?.scrollTo({ y: Math.max(0, browsePaneY.current + searchRowY.current - 12), animated: true });
          }}
        />
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
              <DualAmount cents={product.priceCents} currency={secondCurrency} size="tile" align="left" />
              {product.stock <= 0 ? (
                <Text style={styles.gridStockOut}>Out of stock</Text>
              ) : product.stock <= (product.reorderLevel ?? 5) ? (
                // The number is the useful part when it is nearly gone: "Only 3
                // left" answers "can I sell three?" where a Low stock badge
                // does not.
                <Text style={styles.gridStockLow}>Only {product.stock} left</Text>
              ) : (
                <Text style={styles.gridStock}>{product.stock} in stock</Text>
              )}
              {(heldUnits.get(product.id) ?? 0) > 0 && (
                <Text style={styles.gridHeld}>{heldUnits.get(product.id)} in a held sale</Text>
              )}
              {(() => {
                // One unit's price as the gross: a tile is an offer to sell one, and a
                // promotion with a minimum spend should not claim to apply until
                // the basket actually reaches it.
                const offer = bestPromotionForProduct(product, promotions, product.priceCents, browseClock);
                if (!offer) return null;
                return (
                  <View style={styles.gridOffer}>
                    <Text style={styles.gridOfferText} numberOfLines={1}>{offer.name}</Text>
                  </View>
                );
              })()}
            </View>
          </Pressable>
        ))}
      </GridList>
      </View>
    </View>
  );

  // A shop that requires an open register gets a refusal in place of the cart.
  // The product grid stays browsable behind it on purpose: answering "do you
  // have it in stock?" is harmless, and the cashier can keep serving while a
  // supervisor walks over with the float.
  const registerBlocks = (activeLocation?.requireOpenRegister ?? false) && !registerSession;

  // The two credit controls, built once so the counter and the phone can never
  // show different ones. Each renders nothing when it has nothing to say, which
  // is every sale in a shop that does not give credit.
  const balanceRowEl = (
    <CustomerBalanceRow
      owedCents={balance.owedCents}
      since={balance.oldest?.saleCreatedAt ?? null}
      saleCount={balance.sales.length}
      currency={secondCurrency}
      collecting={settlingCents > 0}
      onCollect={() => setSettlingFor(selectedCustomer?.id ?? null)}
    />
  );
  const restChoiceEl = canOfferCredit ? (
    <RestChoice
      remainingCents={restCents}
      collectedCents={paidCents}
      chosen={payLater}
      customerName={selectedCustomer?.name ?? null}
      currency={secondCurrency}
      onChange={setPayLater}
      onNeedCustomer={() => setCustomerPickerOpen(true)}
    />
  ) : null;

  // The three decisions between a basket and a completed sale, built once and
  // handed to whichever surface is showing them -- the panel on a counter, the
  // sheet on a phone.
  const checkoutBlockProps = shop ? {
    shopId: shop.id,
    selectedCustomer,
    // A redemption is against one specific balance, so changing or clearing
    // the customer has to drop it rather than carry it over.
    onSelectCustomer: (customer: SelectedCustomer) => { setSelectedCustomer(customer); setPointsRedeemed(0); },
    onClearCustomer: () => { setSelectedCustomer(null); setPointsRedeemed(0); },
    totalCents: total,
    payments,
    currencies,
    onChangePayments: setPayments,
    enabledPaymentMethods,
    allowSplit: shop.paymentSplitEnabled ?? true,
    error,
    loyaltyEnabled: loyalty.enabled,
    centsPerPoint: loyalty.centsPerPoint,
    pointsRedeemed,
    maxRedeemable: maxRedeemablePoints(preRedemptionCents, spendablePoints, loyalty),
    pointsMaturing: Math.max((selectedCustomer?.pointsBalance ?? 0) - spendablePoints, 0),
    availableKnown: selectedCustomer?.availablePoints !== null && selectedCustomer?.availablePoints !== undefined,
    redemptionCents: redemption.cents,
    pointsEarned,
    onChangePointsRedeemed: setPointsRedeemed,
    // Slots rather than components built inside the blocks: pos.tsx owns the
    // credit state, and passing them through here is what stops the counter and
    // the phone rendering them in two different places.
    balanceRow: balanceRowEl,
    restChoice: restChoiceEl,
    customerPickerOpen,
    onCustomerPickerOpenChange: setCustomerPickerOpen,
  } : null;


  const cartPaneEl = (
    <View style={[styles.cartPane, compact && styles.cartPaneCompact]}>
      {registerBlocks && <RegisterGate onOpen={() => setRegisterSheet('open')} />}
      {/* The whole sale is ONE card floating on the grey page — it used to be a
          white column with a hairline down its left edge, which read as a
          second page rather than as the thing being built. */}
      {!registerBlocks && (
      <SalePanel
        compact={compact}
        // The counter has the width to take payment in place; the phone does
        // not, so there the button opens the sheet that does.
        mode={compact ? 'sheet' : 'inline'}
        itemCount={cart.reduce((sum, line) => sum + line.quantity, 0)}
        onClearAll={cart.length > 0 ? clearSale : null}
        // Beside the sale itself, not only above the product grid. On a phone
        // the cart renders ABOVE the browse pane, so this is the one scan
        // control that stays in reach mid-checkout without scrolling back up
        // past the whole basket.
        head={<HeldOrdersMenu orders={heldOrders} onResume={resumeSale} />}
        scanButton={scanner.camera ? (
          <Pressable onPress={() => setScannerOpen(true)} style={styles.scanCartButton}>
            <Text style={styles.scanCartButtonText}>⛶ Scan</Text>
          </Pressable>
        ) : null}
        totalCents={total}
        currency={secondCurrency}
        intent={intent}
        onPrimary={compact ? () => setCheckoutOpen(true) : () => checkout()}
        onHold={cart.length > 0 ? holdCurrentSale : null}
        servedBy={cashierName}
        onChangeServedBy={() => (compact ? setCheckoutOpen(true) : setServedByOpen((open) => !open))}
        earnsPoints={pointsEarned}
      >
      {!compact && checkoutBlockProps && (
        <View style={styles.customerBlock}>
          <CustomerBlock {...checkoutBlockProps} />
        </View>
      )}
      <CartList {...cartListProps}>
        {cart.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>Nothing in this sale yet</Text>
            <Text style={styles.empty}>Tap a product, or scan one.</Text>
          </View>
        ) : (
          cart.map((line) => {
            const gross = lineGrossCents(line);
            const discountCents = lineDiscountCents(line, promotions, pricingNow);
            const promo = appliedPromotionForLine(line, promotions, pricingNow);
            const isEditing = editingLineDiscount === line.product.id;
            return (
              <SaleLine
                key={line.product.id}
                line={line}
                grossCents={gross}
                netCents={gross - discountCents}
                offerName={promo && !line.manualDiscount ? promo.name : null}
                currency={secondCurrency}
                canDiscount={can('discounts.manual')}
                editing={isEditing}
                onToggleEditing={() => setEditingLineDiscount(isEditing ? null : line.product.id)}
                onQuantity={(next) => setQuantity(line.product.id, next)}
                onRemove={() => setQuantity(line.product.id, 0)}
                onDiscount={(discount) => { setLineDiscount(line.product.id, discount); setEditingLineDiscount(null); }}
                editor={
                  <DiscountEditor
                    initial={line.manualDiscount}
                    onApply={(discount) => { setLineDiscount(line.product.id, discount); setEditingLineDiscount(null); }}
                    onRemove={line.manualDiscount ? () => { setLineDiscount(line.product.id, null); setEditingLineDiscount(null); } : undefined}
                  />
                }
              />
            );
          })
        )}
      </CartList>
      <View style={styles.discountSection}>
        {/* Nothing to discount until something is rung up: an order discount on
            an empty till is a percentage of zero, and offering it invites a
            cashier to set one and then wonder why the total never moved. */}
        {cart.length > 0 && can('discounts.manual') && (
          <Pressable onPress={() => setEditingTransactionDiscount((open) => !open)} style={styles.orderDiscountChip}>
            <Text style={styles.orderDiscountChipText}>
              {transactionDiscount ? 'Order discount set' : '+ Discount the order'}
            </Text>
          </Pressable>
        )}
        {cart.length > 0 && editingTransactionDiscount && can('discounts.manual') && (
          <View style={styles.orderDiscountPresets}>
            {/* The steps a shop actually gives, in front of the editor rather
                than instead of it -- anything else is still Custom. */}
            {[5, 10, 15, 20].map((percent) => (
              <Pressable
                key={percent}
                onPress={() => { setTransactionDiscount({ type: 'percentage', value: percent }); setEditingTransactionDiscount(false); }}
                style={styles.orderDiscountPreset}
              >
                <Text style={styles.orderDiscountPresetText}>{percent}%</Text>
              </Pressable>
            ))}
            {transactionDiscount && (
              <Pressable
                onPress={() => { setTransactionDiscount(null); setEditingTransactionDiscount(false); }}
                style={styles.orderDiscountPreset}
              >
                <Text style={styles.orderDiscountPresetText}>Remove</Text>
              </Pressable>
            )}
            <View style={styles.orderDiscountEditor}>
              <DiscountEditor
                initial={transactionDiscount}
                onApply={(discount) => { setTransactionDiscount(discount); setEditingTransactionDiscount(false); }}
                onRemove={transactionDiscount ? () => { setTransactionDiscount(null); setEditingTransactionDiscount(false); } : undefined}
              />
            </View>
          </View>
        )}
      </View>
      {/* Nothing to pay for, nothing to decide: an idle till shows the sale it
          is waiting for, not a row of dead payment methods. Above the
          arithmetic, because taking the money is the decision and the
          subtotal is only the explanation of it. */}
      {!compact && checkoutBlockProps && cart.length > 0 && (
        <View style={styles.inlineBlocks}>
          <PaymentBlock {...checkoutBlockProps} />
        </View>
      )}
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
      </View>
      {compact && shop && checkoutBlockProps && (
        <CheckoutPanel
          visible={checkoutOpen}
          onClose={() => setCheckoutOpen(false)}
          cartEmpty={cart.length === 0}
          intent={intent}
          {...checkoutBlockProps}
          fullyPaid={fullyPaid}
          submitting={submitting}
          onCheckout={() => checkout()}
          // The sheet is fully gone, so it's now safe to present the receipt.
          // A no-op when nothing is staged, which is every dismissal that
          // wasn't a completed sale (the cashier tapping Close).
          onDismiss={showStagedReceipt}
        />
      )}
      {/* Who is serving. Sticky across sales, so it sits with the sale rather
          than inside the payment, and it only appears where the shop keeps a
          list of cashiers to choose from. */}
      {servedByOpen && cashiers.length > 0 && (
        <View style={styles.inlineBlocks}>
          <OptionPicker
            title="Served by"
            options={cashiers.map((name) => ({ id: name, label: name }))}
            value={cashierName}
            onChange={(name) => { setCashierName(() => name); setServedByOpen(false); }}
            placeholder="Choose a cashier"
          />
        </View>
      )}
      </SalePanel>
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
      <Split ref={splitRef as never} style={[styles.split, compact && styles.splitCompact]} {...splitProps}>
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
      {/* A flex sibling of the Split, under BOTH panes: the dock belongs to
          the screen, not the search column — the cart stays visible and
          tappable so a cashier can scan or take payment mid-typing. */}
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
          focus with a form the cashier is filling in.
          `registerSheet` covers all four of its states, and the two that count
          a drawer autofocus their first field the moment they open -- a field
          asking for focus while this takes it back every 700ms is the fight
          this list exists to prevent. */}
      {/* Only where the window listener is unavailable -- see the note on
          Inventory's copy of this line. */}
      {sinkFallback && scanner.hardware && !keypadOpen && !scannerOpen && !showAddProduct && registerSheet === null && receipt === null && (
        <WedgeSink onScan={handleScannedCode} />
      )}
      {/* Scanning something the shop doesn't stock yet is a normal event mid-
          sale (new delivery, mislabelled item). Creating it here and dropping
          it straight into the cart beats abandoning the sale to go to
          Inventory and starting over. */}
      {shop && (
        <ProductModal
          visible={showAddProduct}
          // As on Inventory: closing the form clears what the scan that opened
          // it left on the screen behind. The cart is untouched -- that is the
          // sale, not scan residue.
          onClose={() => {
            setShowAddProduct(false);
            setUnknownCode(null);
            setSearch('');
            setScanFeedback(null);
          }}
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
  // One card holds the search, the categories and the grid: the tiles inside it
  // are the soft fill, and without a white ground behind them their edges
  // disappear into the page.
  browseCard: { flex: 1, minHeight: 0, backgroundColor: theme.bentoSurface, borderRadius: BENTO_RADIUS, padding: 16 },
  browseCardCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', padding: 14 },
  browsePaneCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0, padding: 16, paddingBottom: 10 },
  // `minWidth: 0` on both: a dozen categories overflow this row, and without it
  // Yoga sizes the pane to the whole list instead of letting the row scroll --
  // taking the product grid and the sale panel with it.
  categoryScroll: { flexGrow: 0, flexShrink: 0, minWidth: 0 },
  categoryRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 16 },
  categoryScrollCompact: { flexGrow: 0, flexShrink: 0, minWidth: 0 },
  categoryRowCompact: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  gridCompact: { gap: 8 },
  gridScrollCompact: { flexGrow: 0, flexShrink: 0 },
  // Tiles keep a border while the panels float. This is the one screen read at
  // arm's length in shop lighting, and the tile carries the most information
  // per pixel in the app -- a visible edge is worth more here than the cleaner
  // borderless look the desk screens get.
  // Borderless and on the soft tile fill, like every other bento surface -- and
  // narrow enough that a counter screen shows four across instead of three.
  gridTile: {
    flexBasis: '23%',
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 150,
    backgroundColor: theme.bentoSoft,
    borderRadius: BENTO_RADIUS_TILE,
    padding: 12,
  },
  gridTileCompact: { flexBasis: '31%', minWidth: 90, flexGrow: 0, flexShrink: 0, borderRadius: 12, padding: 8 },
  gridTileDisabled: { opacity: 0.45 },
  gridThumb: { width: '100%', aspectRatio: 2.2, borderRadius: 12, marginBottom: 10, backgroundColor: theme.bentoSurface },
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
  gridName: { color: theme.bentoInk, fontSize: 12.5, fontWeight: '700', minHeight: 32, marginTop: 2, lineHeight: 16 },
  gridNameCompact: { fontSize: 11, minHeight: 15, marginTop: 2, lineHeight: 14 },
  gridFooter: { marginTop: 8, alignItems: 'flex-start', gap: 4 },
  gridFooterCompact: { marginTop: 5, flexDirection: 'column', alignItems: 'flex-start', gap: 2 },
  gridPrice: { color: theme.bentoInk, fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'] },
  gridPriceCompact: { fontSize: 13 },
  gridStock: { color: theme.bentoMuted, fontSize: 10.5 },
  gridStockLow: { color: theme.bentoWarn, fontSize: 10.5, fontWeight: '700' },
  gridHeld: { color: theme.bentoAccentInk, fontSize: 10.5, fontWeight: '700' },
  gridStockOut: { color: theme.bentoLoss, fontSize: 10.5, fontWeight: '700' },
  gridOffer: { backgroundColor: theme.bentoUpWash, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 8, marginTop: 2 },
  gridOfferText: { color: theme.bentoUpInk, fontSize: 10, fontWeight: '800' },
  gridStockCompact: { fontSize: 9 },
  gridStockWithBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  // Warm on purpose: a low-stock flag is SUPPOSED to sit warmer than the
  // cool-grey around it.
  stockPill: { fontSize: 10, fontWeight: '800', color: '#8A530F', backgroundColor: '#FDF1E3', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 999, alignSelf: 'flex-start', overflow: 'hidden' },
  stockPillCompact: { fontSize: 8, paddingVertical: 2, paddingHorizontal: 6 },

  // ---- cart: one card, sitting on the page like every other card ----
  inlineBlocks: { paddingHorizontal: 18, paddingBottom: 8 },
  customerBlock: { paddingHorizontal: 18, paddingBottom: 4 },
  cartPane: { flex: 1, padding: 18, paddingLeft: 4, minWidth: 340 },
  cartPaneCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0, padding: 16, paddingBottom: 0 },
  // Spelled out rather than `flex: 0`, matching the panes above: inside the
  // page's vertical scroller the card must size to its content, and a bare
  // `flex: 0` leaves flexBasis to interpretation.
  miniButton: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 11 },
  miniButtonText: { color: theme.bentoInk2, fontSize: 11.5, fontWeight: '700' },
  // The head is one row of matching black pills -- the count, this, and Clear.
  // Scanning is how a basket actually gets built, and this is the one scan
  // control still in reach once the phone has pushed the search field below the
  // cart. Clear carries the same weight at the shop's request; what keeps it
  // from being a one-tap way to lose a basket is the confirm on `clearSale`.
  scanCartButton: { backgroundColor: theme.bentoInk, borderWidth: 1, borderColor: theme.bentoInk, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 16 },
  scanCartButtonText: { color: theme.bentoSurface, fontSize: 13.5, fontWeight: '800' },
  addFromScan: { backgroundColor: theme.bentoInk, borderRadius: 999, paddingHorizontal: 15, paddingVertical: 11, marginBottom: 14, alignSelf: 'flex-start' },
  addFromScanText: { color: theme.bentoSurface, fontSize: 12, fontWeight: '800' },
  cartList: { flex: 1 },
  // The same 18 the head and the foot are inset by. Without it the money and
  // the remove button sit hard against the card's edge while everything above
  // and below them is indented -- and the line dividers run edge to edge.
  cartListContent: { paddingHorizontal: 18 },
  // About four lines. Enough that most sales never scroll at all, and short
  // enough that the total stays on screen when they do.
  cartListCompact: { maxHeight: 320, flexGrow: 0, flexShrink: 0 },
  orderDiscountChip: { alignSelf: 'flex-start', backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, marginTop: 4 },
  orderDiscountChipText: { color: theme.bentoInk2, fontSize: 12.5, fontWeight: '700' },
  orderDiscountPresets: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 },
  orderDiscountPreset: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 13 },
  orderDiscountPresetText: { color: theme.bentoInk2, fontSize: 12, fontWeight: '700' },
  orderDiscountEditor: { width: '100%' },
  emptyWrap: { alignItems: 'center', paddingVertical: 38, gap: 4 },
  emptyTitle: { color: theme.bentoInk2, fontSize: 13.5, fontWeight: '700' },
  empty: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  // A ruled row, not a nested grey card: a card inside a card at every line
  // made the basket read as a stack of panels rather than as a list.
  cartLineDiscountToggle: { color: theme.bentoMuted, fontSize: 11.5, fontWeight: '700', marginTop: 6, textDecorationLine: 'underline' },
  discountSection: { marginTop: 4, paddingHorizontal: 18 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  summaryLabel: { color: theme.bentoMuted, fontSize: 13 },
  summaryValue: { color: theme.bentoInk, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  // Green, not red: money coming OFF the customer's bill is good news for them,
  // and it carries a signed figure so the colour is never the only signal.
  summaryValueDiscount: { color: theme.bentoProfit, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  // The one loud thing on the screen. This is the number said out loud to the
  // customer and the one that gets a sale wrong if it is misread, so it does
  // not share a size with "Subtotal".
});
