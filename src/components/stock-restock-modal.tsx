import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { BarcodeScannerModal } from '@/components/barcode-scanner-modal';
import { CategoryChip } from '@/components/category-chip';
import { ScanFeedbackBanner } from '@/components/scan-feedback-banner';
import { ScanSafeField } from '@/components/scan-safe-field';
import { StoreDropdown } from '@/components/store-dropdown';
import { AppModal } from '@/components/ui/app-modal';
import { useAuth } from '@/hooks/use-auth';
import { useBarcodeWedge } from '@/hooks/use-barcode-wedge';
import { useScannerSettings } from '@/hooks/use-scanner-settings';
import { resolveBarcode, type ScanFeedback } from '@/lib/barcode';
import { listCategories } from '@/lib/categories';
import { extractErrorMessage } from '@/lib/checkout-errors';
import { rowsToCsv } from '@/lib/csv';
import { formatCents } from '@/lib/currency';
import { describePlanError } from '@/lib/entitlements';
import { createExpense } from '@/lib/expenses';
import { shareCsv } from '@/lib/export-file';
import { downloadRejectedRowsCsv, type RejectedRow } from '@/lib/import-shared';
import { toDateColumn } from '@/lib/period';
import { pickCsvFile } from '@/lib/pick-csv-file';
import { isUncosted } from '@/lib/product-costing';
import { listProducts, receiveStock } from '@/lib/products';
import {
  costChanges,
  planRestock,
  receivedUnits,
  RESTOCK_SHEET_COLUMNS,
  RESTOCK_TEMPLATE_COLUMNS,
  restockSheetRows,
  type OversizedReceipt,
  type PlannedReceipt,
  type RestockPlan,
  type RestockSheetRow,
} from '@/lib/restock-import';
import { readTypedCost, readTypedQuantity, type TypedCost } from '@/lib/restock-typed-input';
import type { NewExpenseInput, Product } from '@/types/models';

// Taking in a delivery, by hand or by spreadsheet.
//
// The sibling of StockTransferModal, and deliberately the same shape: a store
// picker, a search row, rows you type a quantity into, a running basket, one
// commit button, and the same two tabs. A shop that has moved stock once can
// receive a delivery without reading anything.
//
// Two differences, and both are load-bearing:
//
//  1. The picker offers the WHOLE catalogue, not just what this store holds.
//     Move can only offer what the source has, and rightly. Restock is the
//     opposite case -- the product being received is very often the one that
//     hit zero, and hiding zero-stock rows would hide exactly what arrived.
//  2. There is a unit cost column. products.cost_cents is nullable and
//     Inventory already carries a `wrong` caveat about the products missing
//     one, because they make stock-at-cost understate and gross profit
//     overstate. A delivery is the one moment the true cost is on the desk.
//
// Scanning here is WEB ONLY, and that is a deliberate platform gate rather than
// an oversight -- see `canScanInSheet` below for the whole reason.

type Tab = 'hand' | 'sheet';
// Both typed fields are held as the RAW string the person typed, never as a
// parsed number and never rewritten on the way in -- see restock-typed-input.ts
// for why that is the whole design of this screen's input handling.
type Line = { product: Product; quantity: string; cost: string };
type LineReading = { line: Line; quantity: number | null; cost: TypedCost };

export function StockRestockModal({
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

  const [tab, setTab] = useState<Tab>('hand');
  const [chosenLocationId, setLocationId] = useState<string | null>(activeLocation?.id ?? selectable[0]?.id ?? null);
  // That initial value is computed once, at first mount, which can be before
  // the session's locations have arrived. A multi-store shop could correct it
  // with the dropdown; a one-store shop could not, because StoreDropdown
  // renders nothing for it -- so the delivery would have nowhere to land and
  // the button would sit dead with no explanation. Resolved on read rather
  // than repaired in an effect, which would be a cascading render.
  const locationId = chosenLocationId ?? activeLocation?.id ?? selectable[0]?.id ?? null;
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  // The basket as an event HANDLER sees it, which is not always what the last
  // render saw.
  //
  // A scan into a Received box is one tick with two halves: `ScanSafeField`
  // puts the box back to the number it held, and then hands the code to
  // `addByCode`, which has to count from that number. A queued updater has not
  // run when the second half executes and the render closure is a render
  // behind, so reading `lines` there could read the barcode itself -- and
  // `readTypedQuantity` refuses a 13-digit number, so the shop's typed 24
  // silently became 1. Every basket write goes through `updateLines`, which
  // computes from this ref and stores the result in both; the assignment below
  // re-points it at whatever React actually committed.
  const linesRef = useRef(lines);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  const updateLines = useCallback((next: (current: Line[]) => Line[]) => {
    const value = next(linesRef.current);
    linesRef.current = value;
    setLines(value);
  }, []);
  const [catalogue, setCatalogue] = useState<Product[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What commitPlan's own success said, the one time a fully successful sheet
  // commit still has rejected rows on screen (see commitPlan's own tail). The
  // by-hand tab has no equivalent state to set it: `submit` still closes the
  // sheet on its own success, because the by-hand basket has no such thing as
  // a "rejected row" to stay open for. Cleared by `commitPlan` and `submit`
  // the moment either starts a fresh write, and by `closeAndReset` for the
  // same reason `error` is.
  const [success, setSuccess] = useState<string | null>(null);
  // Unticked, and it starts unticked again on every open (closeAndReset below).
  //
  // A shop that types its supplier invoices into Accounting separately would
  // otherwise double-count its spending, silently and forever -- and a
  // remembered tick is the same thing one open later. Opt-in is recoverable;
  // opt-out is not. Shared by both tabs because it is one question about this
  // delivery, but each tab decides for itself whether the question can even be
  // asked (see `handExpenseCents` and `planExpenseCents`).
  const [logExpense, setLogExpense] = useState(false);

  // Scanning what arrived, on web and nowhere else.
  //
  // This is a deliberate platform gate rather than an oversight. Scanning
  // inside a sheet was built and reverted (f31d9aa): on Android a React Native
  // Modal is a Dialog with a window of its own, so HardwareKeyboard's capture --
  // which wraps `currentActivity.window` -- never sees the keys, and with
  // nothing swallowing it the scanner's trailing Enter pressed whichever
  // control held focus and closed the sheet, discarding the basket.
  //
  // On web a Modal is a plain DOM node in the same document, the wedge listener
  // is already attached there in the CAPTURE phase, and it already swallows a
  // terminator that completed a scan (use-barcode-wedge.ts:150-155). Neither
  // failure is reachable.
  //
  // Lifting this gate to native requires teaching the native module about the
  // Dialog's window first. Do not do it here.
  const canScanInSheet = Platform.OS === 'web';
  const scanner = useScannerSettings();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);

  // Sheet tab
  const [sheetFile, setSheetFile] = useState<string | null>(null);
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([]);
  const [plan, setPlan] = useState<RestockPlan | null>(null);
  const [sheetNotice, setSheetNotice] = useState<string | null>(null);
  // Set by a commitPlan that did not reach closeAndReset -- either because a
  // store failed (`failed: true`) or because every store went through but
  // rejected rows are still on screen (`failed: false`; see commitPlan's own
  // tail). Read only by the footer. commitPlan empties plan.receipts on
  // EITHER exit so a re-press cannot repeat a store that already went
  // through (see commitPlan) -- but that same clearing is what let the
  // footer claim "nothing has changed yet" directly under an error naming
  // the store that just changed, and is why `failed` exists: without it, a
  // fully successful commit with rejects left behind would read the same
  // "before the failure above" sentence written for an actual one. This
  // remembers what actually went through, for display only; it plays no part
  // in the retry-safety logic below.
  const [partialReceipt, setPartialReceipt] = useState<
    { units: number; stores: number; failed: boolean } | null
  >(null);

  // Scoped to the receiving store so each row can say what is already there --
  // "Has 3 here" is the number that decides whether 24 is right. Unlike Move,
  // rows at zero are KEPT: `listProducts` returns null for a product the store
  // does not carry, so the shop-wide list is fetched too and the two are merged.
  //
  // The merge carries `reorderLevel` alongside `stock`, not just `stock` --
  // `listProducts(shopId, locationId)` already resolves the store's own
  // override (`here.reorder_level ?? row.reorder_level`, products.ts:111),
  // and overrides are a real, settable thing (products.ts:142-149). Without
  // this a store whose own reorder level is 20 against a product default of 5
  // would read "below reorder level 5", or drop the caveat outright, on the
  // one screen where reordering is the subject.
  const load = useCallback(async () => {
    const [all, here] = await Promise.all([
      listProducts(shopId),
      locationId ? listProducts(shopId, locationId) : Promise.resolve([] as Product[]),
    ]);
    const hereByProductId = new Map(here.map((p) => [p.id, p]));
    return all.map((product) => {
      const scoped = hereByProductId.get(product.id);
      return { ...product, stock: scoped?.stock ?? 0, reorderLevel: scoped?.reorderLevel ?? product.reorderLevel };
    });
  }, [shopId, locationId]);

  // The basket is re-pointed at the reloaded rows as well as the picker.
  //
  // A line keeps a whole `Product` snapshot taken when it was added (addLine
  // below), and RowMeta reads its figures off that snapshot -- so without this
  // second setLines, changing store with a full basket would leave every basket
  // row still showing the OLD store's "Has n here" and its "below reorder
  // level n", on the one screen where those two numbers are what decide whether
  // the quantity on the invoice is the quantity to type. Only `product` is
  // replaced; the typed quantity and cost are the person's, not the server's.
  useEffect(() => {
    if (!visible) return;
    let active = true;
    load()
      .then((rows) => {
        if (!active) return;
        setCatalogue(rows);
        const byId = new Map(rows.map((product) => [product.id, product]));
        updateLines((current) =>
          current.map((line) => {
            const fresh = byId.get(line.product.id);
            return fresh ? { ...line, product: fresh } : line;
          })
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [visible, load, updateLines]);

  useEffect(() => {
    if (!visible) return;
    listCategories(shopId)
      .then((rows) => setCategories(rows.map((r) => r.name)))
      .catch(() => {});
  }, [visible, shopId]);

  // Closing has to put everything back, because this component is never
  // unmounted -- the screen renders it with `visible={false}` and it returns
  // null, keeping all of its state. Without this, reopening after a completed
  // delivery shows that delivery still sitting in the basket, with the button
  // stuck reading "Receiving…" because `busy` was never lowered on the success
  // path -- and the stuck flag would be the only thing stopping the same units
  // being received twice.
  const closeAndReset = useCallback(() => {
    setBusy(false);
    updateLines(() => []);
    setNote('');
    setSupplier('');
    setReference('');
    setSearch('');
    setCategory(null);
    setError(null);
    setSuccess(null);
    setPlan(null);
    setSheetFile(null);
    setSheetHeaders([]);
    setSheetNotice(null);
    setPartialReceipt(null);
    setLogExpense(false);
    setScanFeedback(null);
    setScannerOpen(false);
    setTab('hand');
    onClose();
  }, [onClose, updateLines]);

  // Unlike Move, changing the store does NOT clear the basket: what arrived is
  // what arrived, and the quantities were read off an invoice rather than off
  // this store's availability. What changes is the per-store figures each row
  // shows -- "Has n here" and "below reorder level n" -- and the reload effect
  // above re-points the basket's rows at the new store's numbers.

  // Starts empty rather than pre-filled from `costCents`. The recorded cost is
  // shown on the row beside it, so it can be copied when it is still right --
  // but pre-filling would let a stale cost be committed as this delivery's
  // cost by pressing one button, which is the thing this column exists to fix.
  const addLine = (product: Product) => {
    updateLines((current) =>
      current.some((l) => l.product.id === product.id) ? current : [...current, { product, quantity: '1', cost: '' }]
    );
  };

  // Both setters store the keystrokes and nothing else.
  //
  // Deliberately unlike the sibling's QuantityField, and unlike this file's own
  // two previous attempts. Rewriting text inside onChangeText on a controlled
  // input cannot work: the rewritten string is what the NEXT keystroke is
  // appended to, so a number is reinterpreted before it has finished being
  // typed. Dropping the row at quantity 0 was the same mistake wearing a
  // different hat -- one backspace on the seeded "1" unmounted the focused
  // input, closed the keyboard, put the product back in the results list and
  // took the unit cost already typed beside it with it, on the first edit of
  // every line. An empty field is just an empty field here; readTypedQuantity
  // returns null for it, the commit is blocked, and the footer says why.
  //
  // (The sibling's justification does not carry over: its rows start at 0 with
  // an empty field and selectTextOnFocus, it has +/- steppers, and it has no
  // second field whose contents a vanishing row would destroy.)
  const setQuantity = (productId: string, text: string) => {
    updateLines((current) => current.map((l) => (l.product.id === productId ? { ...l, quantity: text } : l)));
  };

  const setCost = (productId: string, text: string) => {
    updateLines((current) => current.map((l) => (l.product.id === productId ? { ...l, cost: text } : l)));
  };

  const removeLine = (productId: string) => {
    updateLines((current) => current.filter((l) => l.product.id !== productId));
  };

  // What every scan path here ends at: the document listener, the search box,
  // the two number boxes, and the camera.
  //
  // Each scan adds ONE, or adds one to a line already in the basket -- scan,
  // scan, scan through a box of the same item is the motion this is for, and it
  // is the most accurate way to take in a delivery, because the count comes off
  // the physical goods rather than off the invoice.
  //
  // Resolved against `catalogue`, which is the whole shop's products rather
  // than what this store carries (see `load`): the thing in the van is very
  // often the thing that hit zero here, and a scan of it must add a line, not
  // report that nothing matches.
  //
  // Not wrapped in useCallback: `useBarcodeWedge` keeps it in a ref, so its
  // identity is irrelevant -- same reasoning as inventory.tsx's handler.
  const addByCode = (raw: string) => {
    const resolution = resolveBarcode(catalogue, raw);
    if (resolution.status === 'not-found') {
      setScanFeedback({ tone: 'error', message: `No product matches ${resolution.code} — add it from Inventory first.` });
      return;
    }
    if (resolution.status === 'ambiguous') {
      setScanFeedback({ tone: 'warn', message: 'More than one product matches that code — add it by name instead.' });
      return;
    }
    const { product } = resolution;
    // Counted INSIDE the update, never off the render's `lines`.
    //
    // The banner has to say the number this scan produced, so the count cannot
    // wait for the render either -- `updateLines` is what makes both possible:
    // it runs this function now, against the basket as it stands after
    // everything earlier in this tick. Which matters, because a scan fired
    // while the cursor is in THIS product's own Received box arrives with a
    // restore already queued in front of it. Reading the render closure there
    // read the barcode as the quantity, `readTypedQuantity` refused it as too
    // large, and the delivery was silently recorded as 1 instead of the 24 that
    // was typed. (Not "lines is never stale": on the wedge path it is not, but
    // the field-sink path puts a write and this read in the same tick.)
    let received = 1;
    updateLines((current) => {
      const existing = current.find((l) => l.product.id === product.id);
      // An unreadable or emptied box starts again at one rather than staying
      // stuck: the scan is a unit that physically arrived, and the alternative
      // is a scan that appears to do nothing.
      received = existing ? (readTypedQuantity(existing.quantity) ?? 0) + 1 : 1;
      return existing
        ? current.map((l) => (l.product.id === product.id ? { ...l, quantity: String(received) } : l))
        : [...current, { product, quantity: '1', cost: '' }];
    });
    // What the last scan did. Without it a scan is a number changing somewhere
    // up the list, which is invisible once the item is in the basket and
    // scrolled out of view.
    setScanFeedback({ tone: 'ok', message: `${product.name} — ${received}` });
  };

  // Focus nowhere: the document listener, for this sheet's own lifetime.
  //
  // Only on the by-hand tab, which is the only one with a basket a scan can act
  // on -- and not while this sheet's own camera scanner is up, so one code can
  // never be read by both. Inventory's wedge is already standing down for the
  // whole time this sheet is open (inventory.tsx's `enabled`), which is what
  // stops a scan being read here AND as an adjustment to the product behind it.
  useBarcodeWedge({
    enabled: canScanInSheet && visible && tab === 'hand' && scanner.hardware && !scannerOpen,
    onScan: addByCode,
  });

  useEffect(() => {
    if (!scanFeedback) return;
    const timer = setTimeout(() => setScanFeedback(null), 4000);
    return () => clearTimeout(timer);
  }, [scanFeedback]);

  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    return catalogue
      .filter((p) => (category === null || p.category === category) && !lines.some((l) => l.product.id === p.id))
      .filter(
        (p) =>
          !query ||
          p.name.toLowerCase().includes(query) ||
          (p.sku ?? '').toLowerCase().includes(query) ||
          (p.barcode ?? '').toLowerCase().includes(query)
      )
      .slice(0, 12);
  }, [catalogue, search, category, lines]);

  // Every typed field read once, here, from the whole string -- the only place
  // in this component that turns text into numbers.
  const readings: LineReading[] = useMemo(
    () => lines.map((line) => ({ line, quantity: readTypedQuantity(line.quantity), cost: readTypedCost(line.cost) })),
    [lines]
  );
  const totalUnits = readings.reduce((sum, reading) => sum + (reading.quantity ?? 0), 0);
  const everyQuantityReads = readings.every((reading) => reading.quantity !== null);
  const noCostIsGibberish = readings.every((reading) => reading.cost.kind !== 'unreadable');

  // Only when there is at least one line, every one of them is priced, and
  // every quantity and price is readable.
  //
  // A part-priced delivery has no honest total, and showing the sum of the
  // priced half would be a smaller number presented as the whole thing. The
  // `readings.length > 0` guard is not redundant: `every` on an empty array is
  // true, so without it an empty basket reports a delivery worth 0.00 rather
  // than no delivery -- which is what Task 8's checkbox would then offer to
  // log as an expense. Nothing NaN can reach this sum: a cost only reads as
  // `cents` when it parsed to a finite number, and a quantity only reads as a
  // number when it is a positive whole one.
  const deliveryCents =
    readings.length > 0 && everyQuantityReads && readings.every((reading) => reading.cost.kind === 'cents')
      ? readings.reduce(
          (sum, reading) => sum + (reading.cost.kind === 'cents' ? reading.cost.cents * (reading.quantity ?? 0) : 0),
          0
        )
      : null;
  // An unreadable cost blocks the commit rather than being sent as null. null
  // means "the delivery did not say", which leaves products.cost_cents alone;
  // silently turning "12.3.4.5" into that would throw away a cost the shop
  // took the trouble to type, on the screen whose whole point is capturing it.
  const canSubmit =
    Boolean(locationId) && readings.length > 0 && everyQuantityReads && noCostIsGibberish && !busy;

  // What this basket may be logged as an inventory purchase, or null for "do
  // not offer it". Two conditions, and both are about not putting a wrong
  // number in the P&L:
  //
  //  * Fully priced. `deliveryCents` is already null unless every line has a
  //    readable cost and a readable quantity (see above), because a part-priced
  //    delivery has no honest total -- logging the priced half as though it
  //    were the whole delivery is a wrong number wearing a right one's clothes.
  //  * Worth something. A zero total is either an empty basket or a delivery of
  //    free samples; "Also log 0.00 as an inventory purchase" is an offer to
  //    write a row that says nothing, and a 0.00 expense in Accounting is
  //    clutter a shop then has to explain to itself.
  const handExpenseCents = deliveryCents !== null && deliveryCents > 0 ? deliveryCents : null;

  // After the units, never before: an expense for a delivery that failed to
  // land is a number in the P&L with no stock behind it. This never throws and
  // never closes anything -- it returns what went wrong so the caller can say
  // so while KEEPING the receipt, because the units really did arrive and
  // rolling them back to punish a failed expense loses the more important of
  // the two. (Returning rather than calling setError is what makes that
  // possible: both callers finish by resetting, which would wipe the message.)
  //
  // `receiptId` is not optional and is not decoration. receive_stock has
  // already posted this delivery as Dr 1200 Inventory / Cr 2000 Accounts
  // Payable, so this row is the shop PAYING for it, and the trigger reads
  // expenses.stock_receipt_id to post Dr 2000 / Cr the wallet -- settling the
  // payable rather than debiting inventory a second time. Without the id it
  // takes the standalone path, 1200 doubles, and a payable is invented against
  // a supplier who was handed cash. Every entry balances either way; nothing
  // anywhere goes red. Hence a required parameter and not an options bag.
  const logInventoryPurchase = async (
    locId: string,
    amountCents: number,
    receiptId: string
  ): Promise<string | null> => {
    try {
      await createExpense(shopId, {
        locationId: locId,
        stockReceiptId: receiptId,
        // Local date, not `toISOString().slice(0, 10)` -- see toDateColumn.
        // An evening delivery west of Greenwich would otherwise land in
        // tomorrow's P&L.
        occurredOn: toDateColumn(new Date()),
        amountCents,
        category: 'inventory_purchase',
        vendorId: null,
        paymentMethod: 'cash',
        note: [supplier.trim(), reference.trim()].filter(Boolean).join(' · ') || null,
      } satisfies NewExpenseInput);
      return null;
    } catch (err) {
      return extractErrorMessage(err);
    }
  };

  const submit = async () => {
    if (!canSubmit || !locationId) return;
    const items: { productId: string; quantity: number; unitCostCents: number | null }[] = [];
    for (const reading of readings) {
      // canSubmit already stopped this; the loop is what proves it to the
      // types, and it runs before `busy` is raised so an impossible line
      // cannot strand the button.
      if (reading.quantity === null || reading.cost.kind === 'unreadable') return;
      items.push({
        productId: reading.line.product.id,
        quantity: reading.quantity,
        unitCostCents: reading.cost.kind === 'cents' ? reading.cost.cents : null,
      });
    }
    setBusy(true);
    setError(null);
    // A fresh by-hand attempt is a fresh attempt: a success banner left over
    // from an earlier sheet-tab commit (see `commitPlan`) must not go on
    // describing that one while this write is in flight, or sit there
    // unexplained beside an error this attempt is about to raise.
    setSuccess(null);
    // ONLY the write is inside the try, and the try ends the moment it resolves.
    //
    // Everything after this point runs against a delivery that has already
    // committed, so nothing after it may reach a catch that leaves the basket
    // standing. It did: `await onDone()` sat here, `onDone` is the Inventory
    // screen's reload, and a reload that throws on a network blip landed in this
    // catch -- an error message beside a full basket and a live Receive button.
    // Pressing it received the same units a second time, rewrote
    // products.cost_cents again, and (because `logExpense` was still ticked)
    // logged the inventory purchase twice.
    // The receipt id is kept, not discarded: it is what tells the expense row
    // below which delivery it is paying for, and therefore what stops it
    // debiting 1200 Inventory a second time. Declared out here because the try
    // ends the moment the write resolves (see above) and the expense is logged
    // well past it.
    let receiptId: string;
    try {
      receiptId = await receiveStock(shopId, locationId, items, {
        supplierName: supplier.trim() || null,
        reference: reference.trim() || null,
        note: note.trim() || null,
      });
    } catch (err) {
      // receive_stock is gated by enforce_shop_module('inventory'), which
      // raises the literal string "module_not_included" -- describePlanError
      // turns that (and a limit-reached error) into a sentence before the
      // generic fallback ever sees it. Same precedent as the sibling
      // (stock-transfer-modal.tsx's local extractErrorMessage).
      //
      // Nothing was received, so the basket is deliberately left exactly as it
      // is: this is the one failure a shop fixes by pressing the button again.
      setError(describePlanError(err) ?? extractErrorMessage(err));
      setBusy(false);
      return;
    }

    // The units are IN. The basket is spent from here on, and it is emptied
    // before anything that can fail, so no later failure can leave a full
    // basket under a live Receive button. `logExpense` goes with it: it is the
    // yes to a question about a delivery that is now over.
    updateLines(() => []);
    setNote('');
    setLogExpense(false);

    // Only after the units are in, and only if the offer was actually on
    // screen -- `handExpenseCents` is re-read here rather than trusting
    // `logExpense` alone, because the tick survives an edit that unprices a
    // line and the checkbox merely disappearing must not leave a stale yes.
    // (Both are read from this render's closure, so emptying the basket above
    // does not change either.)
    const expenseProblem =
      logExpense && handExpenseCents !== null
        ? await logInventoryPurchase(locationId, handExpenseCents, receiptId)
        : null;
    // Swallowed on purpose. This is the caller's list refresh, not part of the
    // delivery -- a stale Inventory list is a pull-to-refresh away, while
    // treating its failure as this screen's failure is what produced the
    // double-receive above.
    await onDone().catch(() => {});
    if (expenseProblem) {
      // The sheet stays open carrying the one sentence that says what happened
      // and what is left to do by hand; closing here would show the message for
      // no time at all. The basket is already empty, so the button still on
      // screen cannot receive the same units again.
      setError(`The stock was received, but the expense was not logged: ${expenseProblem}`);
      setBusy(false);
      return;
    }
    closeAndReset();
  };

  // --- the sheet tab ------------------------------------------------------

  // What every store holds, keyed `productId|locationId`. Both halves of the
  // sheet need it: the download states each count, and the preview compares
  // each received quantity against what the store already has.
  const loadStockByLocation = useCallback(async (): Promise<Map<string, number>> => {
    const stock = new Map<string, number>();
    await Promise.all(
      selectable.map(async (location) => {
        for (const product of await listProducts(shopId, location.id)) {
          stock.set(`${product.id}|${location.id}`, product.stock);
        }
      })
    );
    return stock;
  }, [shopId, selectable]);

  // Every product at every store, not just the one selected above -- the sheet
  // names its own Store on every row, so restricting it would quietly make it a
  // worse tool than the tab it sits in.
  //
  // Rows already in the basket come back pre-filled, so a shop that starts by
  // hand and realises it is a bigger job than it thought does not retype them.
  const downloadSheet = async () => {
    setBusy(true);
    setError(null);
    try {
      const stockByLocation = await loadStockByLocation();
      const rows = restockSheetRows(await listProducts(shopId), selectable, (productId, locId) =>
        stockByLocation.get(`${productId}|${locId}`) ?? 0
      );
      const columns = RESTOCK_SHEET_COLUMNS.map((column) =>
        column.header === 'Quantity received' || column.header === 'Unit cost'
          ? {
              header: column.header,
              value: (row: RestockSheetRow) => {
                // Only the row for the store the basket is receiving INTO --
                // the same product's row at another store was not what was
                // chosen, and pre-filling it would receive the delivery twice.
                const chosen = row.location.id === locationId
                  ? lines.find((l) => l.product.id === row.product.id)
                  : undefined;
                if (!chosen) return '';
                // Both are already the raw strings the person typed -- see the
                // Line type. Neither needs converting on the way out.
                return column.header === 'Quantity received' ? chosen.quantity : chosen.cost;
              },
            }
          : column
      );
      await shareCsv(rowsToCsv(rows, columns), 'restock-sheet.csv', 'Restock sheet');
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const uploadSheet = async () => {
    setError(null);
    setSheetNotice(null);
    const picked = await pickCsvFile(RESTOCK_TEMPLATE_COLUMNS);
    if (picked.status === 'cancelled') return;
    if (picked.status === 'error') {
      setError(picked.message);
      return;
    }
    const products = await listProducts(shopId);
    const stockByLocation = await loadStockByLocation();

    const next = planRestock(picked.parsed, {
      products,
      locations: selectable,
      stockAt: (productId, locId) => stockByLocation.get(`${productId}|${locId}`) ?? 0,
    });
    // A fresh upload is a fresh attempt -- without this, re-uploading after a
    // partial failure to retry the rest would leave the previous attempt's
    // "N units already in" banner sitting under a brand new preview.
    setPartialReceipt(null);

    // A sheet that turns out to be one store is the same thing the by-hand tab
    // holds, so it lands there -- where a number can still be changed before
    // anything is received. More than one store has no single destination to
    // show, so it stays here as a summary.
    const handedOver = next.receipts.length === 1 && next.rejected.length === 0;
    // The plan is DROPPED when it is handed over, not merely stepped away from.
    //
    // Left standing, it sat behind the `By sheet` tab as a live preview of the
    // ORIGINAL file with `Receive N units` still enabled -- so a shop that
    // corrected 24 to 12 on the by-hand tab and glanced back at the sheet could
    // receive the 24 the file said. The basket is now the only copy of this
    // delivery, which is the whole point of handing it over.
    setSheetFile(handedOver ? null : picked.fileName);
    setSheetHeaders(handedOver ? [] : picked.parsed.headers);
    setPlan(handedOver ? null : next);

    if (handedOver) {
      const receipt = next.receipts[0];
      const byId = new Map(products.map((p) => [p.id, p]));
      setLocationId(receipt.locationId);
      updateLines(() =>
        receipt.items.flatMap((item) =>
          byId.has(item.productId)
            ? [{
                product: byId.get(item.productId)!,
                // Both basket fields hold the RAW string a person typed, so a
                // planned number is turned back into text on the way in --
                // see the Line type and restock-typed-input.ts for why.
                quantity: String(item.quantity),
                cost: item.unitCostCents === null ? '' : (item.unitCostCents / 100).toFixed(2),
              }]
            : []
        )
      );
      if (receipt.note) setNote(receipt.note);
      setSheetNotice(`${picked.fileName} — ${receipt.items.length} product${receipt.items.length === 1 ? '' : 's'} ready. Change anything before receiving.`);
      setTab('hand');
    }
  };

  // The sheet tab's own answer to the question `handExpenseCents` answers for
  // the basket. It has to be asked separately -- the plan is not the basket,
  // and a committed plan can be several stores -- but the rule is the same one,
  // because a checkbox that meant "every line priced" on one tab and "some
  // lines priced" on the other would mean nothing on either.
  //
  // `receipts.length > 0` and `items.length > 0` are not redundant: `every` on
  // an empty array is true, so without them an empty plan reports itself fully
  // priced and worth 0.00 -- the same trap `deliveryCents` guards against above.
  const planFullyPriced =
    plan !== null &&
    plan.receipts.length > 0 &&
    plan.receipts.every((r) => r.items.length > 0 && r.items.every((item) => item.unitCostCents !== null));
  const receiptCents = (receipt: PlannedReceipt) =>
    receipt.items.reduce((sum, item) => sum + (item.unitCostCents ?? 0) * item.quantity, 0);
  const planCents = plan ? plan.receipts.reduce((sum, receipt) => sum + receiptCents(receipt), 0) : 0;
  const planExpenseCents = planFullyPriced && planCents > 0 ? planCents : null;

  // One receive_stock call per store. A store that fails fails whole and is
  // named; the others still go through, because rolling back good work for a
  // problem the shop can fix by re-uploading one section helps nobody.
  const commitPlan = async () => {
    if (!plan || plan.receipts.length === 0) return;
    setBusy(true);
    setError(null);
    // A fresh commit is a fresh attempt -- see `submit`'s own identical clear
    // for why.
    setSuccess(null);
    const failures: string[] = [];
    // Kept apart from `failures`, which heads its error with "Some of the
    // delivery did not go through". A logged-expense failure is the opposite
    // case -- all of the delivery went through and a bookkeeping row did not --
    // and folding the two together would tell a shop its stock is missing when
    // it is on the shelf.
    const expenseProblems: string[] = [];
    const succeeded: PlannedReceipt[] = [];
    for (const receipt of plan.receipts) {
      try {
        // This store's own receipt id, per iteration -- the expense below pays
        // for THIS delivery, and pointing it at another store's receipt would
        // settle the wrong payable.
        const receiptId = await receiveStock(
          shopId,
          receipt.locationId,
          receipt.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitCostCents: item.unitCostCents,
          })),
          { supplierName: supplier.trim() || null, reference: reference.trim() || null, note: receipt.note }
        );
        succeeded.push(receipt);
        // Per store, inside the loop, right after that store's units land --
        // not one lump after it. Each store's delivery is its own receipt, and
        // per-store reporting (migration 20260816000000) would otherwise
        // attribute the whole delivery to whichever store happened to be
        // first. `logInventoryPurchase` cannot throw, which matters here: an
        // expense failure reaching the catch below would name this store as a
        // store whose stock did not arrive, when it did.
        if (logExpense && planExpenseCents !== null) {
          const cents = receiptCents(receipt);
          if (cents > 0) {
            const problem = await logInventoryPurchase(receipt.locationId, cents, receiptId);
            if (problem) expenseProblems.push(`${receipt.locationName}: ${problem}`);
          }
        }
      } catch (err) {
        // Same RPC, same enforce_shop_module('inventory') gate, as the by-hand
        // submit's `describePlanError(err) ?? extractErrorMessage(err)` right
        // above -- so a Free/Standard shop committing from the sheet reads a
        // sentence for `module_not_included`, not the bare Postgres string a
        // shop committing by hand no longer sees.
        failures.push(`${receipt.locationName}: ${describePlanError(err) ?? extractErrorMessage(err)}`);
      }
    }
    // The loop is over, so this list is SPENT -- every store in it either
    // received or failed whole, and a store that failed is fixed by editing that
    // section of the sheet and uploading it again, never by pressing this button
    // a second time. Emptied here, before anything that can throw, rather than
    // inside the failure branch below: `await onDone()` used to sit above that
    // branch and reach nothing when the caller's reload rejected, leaving the
    // whole plan on screen with a live Receive button that would have repeated
    // every store that already went through.
    setPlan({ ...plan, receipts: [] });
    const failed = failures.length > 0 || expenseProblems.length > 0;
    // What actually went through, for the footer -- which otherwise has nothing
    // left to read "nothing has changed yet" against, receipts being empty on
    // purpose. Cleared again by closeAndReset on the all-succeeded, all-accepted
    // path.
    setPartialReceipt(
      succeeded.length > 0
        ? {
            units: succeeded.reduce((sum, receipt) => sum + receivedUnits(receipt), 0),
            stores: succeeded.length,
            failed,
          }
        : null
    );
    // Swallowed on purpose, exactly as in `submit` above: the caller's list
    // refresh is not part of the delivery, and its failure must not be reported
    // as one.
    await onDone().catch(() => {});
    setBusy(false);
    if (failed) {
      // An expense problem alone lands here too -- the stock is in, so the plan
      // is spent either way and the sentence says which store's expense is left
      // to add by hand.
      setError(
        [
          failures.length > 0 ? `Some of the delivery did not go through.\n${failures.join('\n')}` : null,
          expenseProblems.length > 0
            ? `The stock was received, but the expense was not logged:\n${expenseProblems.join('\n')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n\n')
      );
      return;
    }
    // Every store received. `plan.rejected` is untouched by the loop above --
    // it is planRestock's own reading of the upload -- so a sheet that carried
    // both good rows and bad ones still has its bad ones sitting right here,
    // with the modal about to take the only way to see them or download them
    // along with it. CsvImportModal's own import report stays open for
    // exactly this reason (see its `step === 'done'` branch): closing is the
    // right move only once there is nothing left on screen to show.
    if (plan.rejected.length > 0) {
      setSuccess(sheetCommitSuccessText(succeeded, plan.rejected.length));
      return;
    }
    closeAndReset();
  };

  const downloadRejected = async () => {
    if (!plan || plan.rejected.length === 0) return;
    await downloadRejectedRowsCsv(plan.rejected, sheetHeaders, 'restock-rejected.csv');
  };

  if (!visible) return null;

  const valueHint = deliveryHint(readings, deliveryCents);
  const planUnits = plan ? plan.receipts.reduce((sum, receipt) => sum + receivedUnits(receipt), 0) : 0;
  const canCommitPlan = Boolean(plan) && (plan?.receipts.length ?? 0) > 0 && !busy;

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={closeAndReset}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Restock</Text>
            <Pressable onPress={closeAndReset} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <View style={styles.segment}>
            {(['hand', 'sheet'] as const).map((option) => (
              <Pressable
                key={option}
                onPress={() => setTab(option)}
                accessibilityState={{ selected: tab === option }}
                style={[styles.segmentItem, tab === option && styles.segmentItemActive]}
              >
                <Text style={[styles.segmentText, tab === option && styles.segmentTextActive]}>
                  {option === 'hand' ? 'By hand' : 'By sheet'}
                </Text>
              </Pressable>
            ))}
          </View>

          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>RECEIVING INTO</Text>
            <StoreDropdown
              value={locationId}
              onChange={setLocationId}
              allowAll={false}
              variant="field"
              title="Receive stock into"
              placeholder="Choose a store"
            />

            {/* On BOTH tabs, not just by-hand: commitPlan (the sheet's commit)
                stamps this same supplier/reference across every receipt in
                the plan, exactly as the by-hand submit stamps it on its one
                receipt. One supplier delivering to three stores on one
                invoice is a real case, so sharing the reference across a
                multi-store plan is correct -- it just has to be something the
                person can see and clear while looking at the plan they are
                about to commit, not a value carried over from a tab they
                never opened. The state is shared (`supplier`/`reference`
                above), so filling it in on one tab is what the other commits
                too. */}
            <Text style={[styles.label, styles.labelSpaced]}>
              SUPPLIER &amp; REFERENCE <Text style={styles.labelOptional}>— optional</Text>
            </Text>
            <View style={styles.fieldRow}>
              <TextInput
                value={supplier}
                onChangeText={setSupplier}
                placeholder="Who it came from"
                placeholderTextColor="#999999"
                style={[styles.input, styles.fieldHalf]}
              />
              <TextInput
                value={reference}
                onChangeText={setReference}
                placeholder="Invoice no."
                placeholderTextColor="#999999"
                style={[styles.input, styles.fieldHalf]}
              />
            </View>

            {tab === 'hand' ? (
              <>
                {/* Set by an upload that turned out to be one store, which
                    lands here rather than staying on the sheet tab. Without it
                    the basket would fill from nowhere with no explanation. */}
                {sheetNotice ? <Text style={styles.notice}>{sheetNotice}</Text> : null}

                <Text style={[styles.label, styles.labelSpaced]}>ADD PRODUCTS</Text>
                {/* Deliberately NOT cleared when a product is added: clearing it
                    is what made moving fifteen items mean typing fifteen
                    searches on the Move sheet, which is why shops reached for
                    Import instead.

                    A scan INTO this box is a different thing from typing into
                    it: the code is not a search term, so `ScanSafeField` gives
                    the box back whatever it held before the burst -- usually
                    nothing, which is the box clearing -- and the product goes
                    into the basket instead. On native `onScan` is null and this
                    is an ordinary text field. */}
                <View style={styles.searchRow}>
                  <ScanSafeField
                    value={search}
                    onChangeText={setSearch}
                    onScan={canScanInSheet ? addByCode : null}
                    placeholder={
                      canScanInSheet ? 'Search or scan — name, SKU or barcode' : 'Search by name, SKU or barcode'
                    }
                    placeholderTextColor="#999999"
                    style={[styles.input, styles.searchField]}
                  />
                  {/* Web only, like everything else here. BarcodeScannerModal
                      works in a browser -- only torch and haptics are
                      native-gated -- and a modal over a modal is fine there. */}
                  {canScanInSheet && scanner.camera ? (
                    <Pressable
                      onPress={() => setScannerOpen(true)}
                      style={styles.scanPill}
                      accessibilityRole="button"
                      accessibilityLabel="Scan a barcode"
                    >
                      <Text style={styles.scanPillText}>Scan</Text>
                    </Pressable>
                  ) : null}
                </View>
                <ScanFeedbackBanner feedback={scanFeedback} />
                {categories.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.chipScroll}
                    contentContainerStyle={styles.chips}
                  >
                    <CategoryChip label="All" active={category === null} onPress={() => setCategory(null)} />
                    {categories.map((item) => (
                      <CategoryChip
                        key={item}
                        label={item}
                        active={category === item}
                        onPress={() => setCategory(item)}
                      />
                    ))}
                  </ScrollView>
                )}

                {matches.map((product) => (
                  <MatchRow key={product.id} product={product} onAdd={() => addLine(product)} />
                ))}
                {lines.length === 0 && matches.length === 0 && (
                  <Text style={styles.empty}>
                    {search.trim() ? 'Nothing here matches that.' : 'Search above to add what arrived.'}
                  </Text>
                )}

                {lines.length > 0 && (
                  <View style={styles.basket}>
                    <View style={styles.basketCap}>
                      <Text style={styles.basketCapLabel}>RECEIVING</Text>
                      <Text style={styles.basketCapTotal}>
                        {lines.length} product{lines.length === 1 ? '' : 's'} · {totalUnits} unit
                        {totalUnits === 1 ? '' : 's'}
                      </Text>
                    </View>
                    {lines.map((line) => (
                      <LineRow
                        key={line.product.id}
                        line={line}
                        onQuantity={(text) => setQuantity(line.product.id, text)}
                        onCost={(text) => setCost(line.product.id, text)}
                        onRemove={() => removeLine(line.product.id)}
                        onScan={canScanInSheet ? addByCode : null}
                      />
                    ))}
                  </View>
                )}

                <Text style={[styles.label, styles.labelSpaced]}>NOTE</Text>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Anything worth recording about this delivery"
                  placeholderTextColor="#999999"
                  style={styles.input}
                />
              </>
            ) : (
              <SheetTab
                fileName={sheetFile}
                plan={plan}
                busy={busy}
                onDownload={downloadSheet}
                onUpload={uploadSheet}
                onDownloadRejected={downloadRejected}
              />
            )}

            {error && <Text style={styles.error}>{error}</Text>}
            {success && <Text style={styles.success}>{success}</Text>}
          </ScrollView>

          <View style={styles.footerWrap}>
            {/* Above the buttons rather than beside them: it is a question
                about the delivery, and a shop should read it on the way to the
                button whose meaning it changes. Only ever rendered when THIS
                tab has an honest, non-zero total to name -- see
                `handExpenseCents` and `planExpenseCents`. */}
            <ExpenseCheck
              cents={tab === 'hand' ? handExpenseCents : planExpenseCents}
              on={logExpense}
              onToggle={() => setLogExpense((ticked) => !ticked)}
            />
            <View style={styles.footerRow}>
              {tab === 'hand' ? (
                <>
                  <View style={styles.footerTotal}>
                    <Text style={styles.footerTotalText}>
                      {totalUnits} unit{totalUnits === 1 ? '' : 's'} in
                    </Text>
                    <Text style={styles.footerTotalHint}>{locationId ? valueHint : 'Choose a store'}</Text>
                  </View>
                  <Pressable onPress={submit} disabled={!canSubmit} style={[styles.primary, !canSubmit && styles.disabled]}>
                    <Text style={styles.primaryText}>
                      {busy ? 'Receiving…' : `Receive ${totalUnits} unit${totalUnits === 1 ? '' : 's'}`}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <View style={styles.footerTotal}>
                    <Text style={styles.footerTotalText}>
                      {partialReceipt
                        ? `${partialReceipt.units} unit${partialReceipt.units === 1 ? '' : 's'} already in`
                        : plan
                          ? `${planUnits} unit${planUnits === 1 ? '' : 's'} in`
                          : 'No sheet yet'}
                    </Text>
                    {/* "nothing has changed yet" is the whole promise of this
                        tab before a commit: the preview above is a reading of
                        the file, not a record of anything received. But
                        commitPlan can fail PARTIALLY -- some stores go through,
                        one is named in the error above, and plan.receipts is
                        then emptied so a re-press cannot repeat what already
                        landed. That empty plan is not "nothing happened"; it is
                        "some of it happened and this list is spent". partialReceipt
                        carries what actually went through so this line says so,
                        right beneath the error naming what did not. */}
                    <Text style={styles.footerTotalHint}>
                      {partialReceipt
                        ? partialReceipt.failed
                          ? `to ${partialReceipt.stores} store${partialReceipt.stores === 1 ? '' : 's'} before the failure above`
                          : `to ${partialReceipt.stores} store${partialReceipt.stores === 1 ? '' : 's'} · nothing left to receive`
                        : plan
                          ? `across ${plan.receipts.length} store${plan.receipts.length === 1 ? '' : 's'} · nothing has changed yet`
                          : 'Download, fill it in, upload it back'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={commitPlan}
                    disabled={!canCommitPlan}
                    style={[styles.primary, !canCommitPlan && styles.disabled]}
                  >
                    <Text style={styles.primaryText}>
                      {busy ? 'Receiving…' : `Receive ${planUnits} unit${planUnits === 1 ? '' : 's'}`}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          </View>
        </View>
      </View>

      {/* Over the sheet, which is only ever a browser here -- on native this is
          never rendered at all. Continuous, because a delivery is a box of
          items rather than one question: each scan adds one and the banner
          says what it was, and the scanner closes when the shop says so. */}
      {canScanInSheet && scannerOpen ? (
        <BarcodeScannerModal
          visible
          onClose={() => setScannerOpen(false)}
          onScan={addByCode}
          mode="continuous"
          title="Scan what arrived"
          hint="Each scan adds one unit."
          feedback={scanFeedback}
        />
      ) : null}
    </AppModal>
  );
}

// The offer to write this delivery into Accounting as well as into stock.
//
// `cents === null` is the whole gate and it renders nothing: a delivery whose
// lines are not all priced has no honest total, so there is no number to put in
// the sentence and no offer worth making. It is never disabled-but-visible,
// because a greyed checkbox invites a shop to work out what would un-grey it,
// and the answer ("price every line") belongs to the footer hint that already
// says it.
function ExpenseCheck({ cents, on, onToggle }: { cents: number | null; on: boolean; onToggle: () => void }) {
  if (cents === null) return null;
  return (
    <Pressable onPress={onToggle} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={styles.checkRow}>
      <View style={[styles.checkBox, on && styles.checkBoxOn]}>{on && <Text style={styles.checkMark}>✓</Text>}</View>
      <Text style={styles.checkLabel}>Also log {formatCents(cents)} as an inventory purchase</Text>
    </Pressable>
  );
}

// The line under the unit count, which is also the only place a blocked commit
// is explained. Ordered by what the person has to do next: a figure when there
// is one, then the two things that hold the button down, then the one that
// merely withholds the total.
function deliveryHint(readings: LineReading[], deliveryCents: number | null): string {
  if (readings.length === 0) return 'Nothing added yet';
  if (deliveryCents !== null) return `Delivery value ${formatCents(deliveryCents)}`;
  if (readings.some((reading) => reading.quantity === null)) return 'Type how many arrived on every line';
  // Told apart from the sentence below it because they ask for different
  // things. A number too big for the column is usually a decimal point in the
  // wrong place or a pasted cell, and "that is not an amount of money" reads as
  // a lie against a field holding digits and nothing else.
  if (readings.some((reading) => reading.cost.kind === 'unreadable' && reading.cost.reason === 'too-large'))
    return 'One unit cost is larger than a cost can be — check the decimal point';
  if (readings.some((reading) => reading.cost.kind === 'unreadable'))
    return 'One unit cost is not an amount of money — fix it or clear it';
  return 'Add a unit cost to every line for a delivery value';
}

// commitPlan's own success line -- read only once every store in the plan has
// received and the only thing left on the sheet tab is rows planRestock
// already refused.
function sheetCommitSuccessText(succeeded: PlannedReceipt[], rejectedRowCount: number): string {
  const units = succeeded.reduce((sum, receipt) => sum + receivedUnits(receipt), 0);
  const stores = succeeded.length;
  return `${units} unit${units === 1 ? '' : 's'} received across ${stores} store${
    stores === 1 ? '' : 's'
  }. ${rejectedRowCount} row${rejectedRowCount === 1 ? '' : 's'} rejected.`;
}

// What the receiving store already holds, and what it costs -- the two numbers
// that decide whether the quantity on the invoice is the quantity to type.
//
// "Has 0 here" is a row that stays. On the Move sheet a product the source has
// none of is nothing to offer; here it is the likeliest thing in the van.
function RowMeta({ product }: { product: Product }) {
  const low = product.reorderLevel != null && product.stock <= product.reorderLevel;
  // isUncosted, not `costCents === null` written out twice: whether a product
  // counts as missing a cost is one app-wide rule (a recorded zero is a free
  // sample, not an unanswered question), and it lives in one place.
  const recorded = isUncosted(product) ? null : product.costCents;
  return (
    <>
      <Text style={styles.lineMeta}>
        Has {product.stock} here
        {recorded !== null ? ` · cost ${formatCents(recorded)}` : ''}
        {low ? ' · ' : ''}
        {low ? <Text style={styles.lineMetaLow}>below reorder level {product.reorderLevel}</Text> : ''}
      </Text>
      {recorded === null && (
        <Text style={styles.lineMetaMissing}>
          No cost recorded — add one here and stock at cost stops understating
        </Text>
      )}
    </>
  );
}

function MatchRow({ product, onAdd }: { product: Product; onAdd: () => void }) {
  return (
    <Pressable onPress={onAdd} style={styles.lineWrap} accessibilityRole="button">
      <View style={styles.lineRow}>
        <View style={styles.lineText}>
          <Text style={styles.lineName}>{product.name}</Text>
          <RowMeta product={product} />
        </View>
        <Text style={styles.add}>Add</Text>
      </View>
    </Pressable>
  );
}

// Typed, not stepped: a stepper is "+1" forty times, and a delivery is bigger
// than a transfer, not smaller.
function LineRow({
  line,
  onQuantity,
  onCost,
  onRemove,
  onScan,
}: {
  line: Line;
  onQuantity: (text: string) => void;
  onCost: (text: string) => void;
  onRemove: () => void;
  /**
   * Where a scan that lands in one of these boxes goes instead of into it.
   *
   * Not "handle the scan too" -- REPLACE what the field would have done with
   * it. Every character of a barcode is a digit, so without this the box
   * silently takes the code as its value and a delivery of 6 units is recorded
   * as a delivery of 8,809,611,860,018. Null on native, where no scan can reach
   * a sheet at all.
   */
  onScan: ((code: string) => void) | null;
}) {
  return (
    <View style={styles.lineWrap}>
      <View style={styles.lineRow}>
        <View style={styles.lineText}>
          <Text style={styles.lineName}>{line.product.name}</Text>
          <RowMeta product={line.product} />
          <Pressable onPress={onRemove} style={styles.remove} accessibilityRole="button">
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        </View>
        <View style={styles.qtyPair}>
          <View>
            <Text style={styles.cap}>RECEIVED</Text>
            <ScanSafeField
              // The typed text itself. Emptying it leaves an empty field and a
              // row that stays put with its unit cost intact; the footer says
              // what is missing and the commit waits.
              value={line.quantity}
              onChangeText={onQuantity}
              onScan={onScan}
              // Not "0": readTypedQuantity rejects a typed zero (nothing
              // arrived is not a delivery line), so a greyed 0 would be the
              // field advertising the one value that keeps the button down.
              // "1" is the seeded value, and typing it changes nothing.
              placeholder="1"
              placeholderTextColor="#999999"
              keyboardType="number-pad"
              inputMode="numeric"
              // Seeded at "1", so the usual next action is replacing it rather
              // than appending to it -- without this, tapping the field and
              // typing 24 gives 124 or 241.
              selectTextOnFocus
              aria-label={`Units of ${line.product.name} received`}
              style={styles.qtyInput}
            />
          </View>
          <View>
            <Text style={styles.cap}>UNIT COST</Text>
            <ScanSafeField
              value={line.cost}
              onChangeText={onCost}
              onScan={onScan}
              placeholder={isUncosted(line.product) ? '0.00' : ((line.product.costCents ?? 0) / 100).toFixed(2)}
              placeholderTextColor="#999999"
              keyboardType="decimal-pad"
              aria-label={`Unit cost of ${line.product.name}`}
              style={[styles.qtyInput, styles.costInput]}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

// The whole sheet route on one screen: get the file, fill it, bring it back,
// read what it says, press the button. Nothing above the footer writes -- the
// plan is planRestock's pure reading of the upload, held in state and shown.
function SheetTab({
  fileName,
  plan,
  busy,
  onDownload,
  onUpload,
  onDownloadRejected,
}: {
  fileName: string | null;
  plan: RestockPlan | null;
  busy: boolean;
  onDownload: () => void;
  onUpload: () => void;
  onDownloadRejected: () => void;
}) {
  const changes = plan ? costChanges(plan) : [];
  // One sentence per product this sheet prices two ways, not one per row: the
  // clash belongs to the product, and naming it twice would read as two
  // separate problems.
  const clashes = [...new Map(changes.filter((c) => c.conflicting).map((c) => [c.productId, c])).values()];

  return (
    <>
      <Text style={[styles.label, styles.labelSpaced]}>THE SHEET</Text>
      <Text style={styles.help}>
        Every product at every store, with what each holds now. Fill in{' '}
        <Text style={styles.helpStrong}>Quantity received</Text> — and <Text style={styles.helpStrong}>Unit cost</Text>, if
        you have it.
      </Text>
      <View style={styles.sheetActions}>
        <Pressable onPress={onDownload} disabled={busy} style={styles.ghost}>
          <Text style={styles.ghostText}>Download the sheet</Text>
        </Pressable>
        <Pressable onPress={onUpload} disabled={busy} style={styles.ghost}>
          <Text style={styles.ghostText}>Upload a filled sheet</Text>
        </Pressable>
      </View>
      {fileName ? <Text style={styles.fileName}>{fileName}</Text> : null}

      {plan && (
        <>
          {/* Each pill only when it has something to say. A "0 rejected" pill
              is a red-adjacent nothing, and `skipped` gets the plain wording
              it deserves: the sheet is a download of the whole catalogue, so
              most of it is MEANT to come back untouched. */}
          <View style={styles.pills}>
            {plan.receipts.length > 0 && (
              <Pill
                tone="ok"
                text={`${plan.receipts.length} receipt${plan.receipts.length === 1 ? '' : 's'} · ${plan.receipts.reduce(
                  (sum, receipt) => sum + receivedUnits(receipt),
                  0
                )} units`}
              />
            )}
            {plan.skipped > 0 && <Pill tone="warn" text={`${plan.skipped} rows left blank — skipped`} />}
            {plan.rejected.length > 0 && <Pill tone="bad" text={`${plan.rejected.length} rejected`} />}
            {changes.length > 0 && (
              <Pill tone="acc" text={`${changes.length} cost${changes.length === 1 ? '' : 's'} updated`} />
            )}
          </View>

          {plan.receipts.length > 0 && (
            <>
              <Text style={[styles.label, styles.labelSpaced]}>WHAT WILL BE RECEIVED</Text>
              {plan.receipts.map((receipt: PlannedReceipt) => (
                <View key={receipt.locationId} style={styles.receipt}>
                  <View style={styles.receiptCap}>
                    <Text style={styles.receiptName}>{receipt.locationName}</Text>
                    <Text style={styles.receiptMeta}>
                      {receipt.items.length} product{receipt.items.length === 1 ? '' : 's'} · {receivedUnits(receipt)} units
                    </Text>
                  </View>
                  {receipt.items.map((item) => (
                    <View key={item.productId} style={styles.receiptItem}>
                      <Text style={styles.receiptItemName} numberOfLines={2}>
                        {item.productName}
                      </Text>
                      <Text style={styles.receiptItemQty}>+{item.quantity}</Text>
                    </View>
                  ))}
                </View>
              ))}

              {/* The costs, itemised -- the one write on this screen that used
                  to be summarised and never shown.
                  `previousCostCents` has existed since the plan was first
                  written, precisely "so the preview can say 4.50 → 4.80 before
                  anything is written", and nothing rendered it: the whole
                  change arrived as a pill reading "2 costs updated". This is
                  the highest-risk write the sheet makes -- products.cost_cents
                  is what stock at cost and gross profit are built from, and it
                  has no history.

                  It said "→ 4.80" flatly until
                  20260907000000_moving_weighted_average.sql, which was true
                  while receive_stock replaced the cost with the delivery's
                  price. It averages now, so the cost lands BETWEEN the two and
                  a flat arrow would have promised a figure the commit does not
                  produce.

                  "toward", not a computed figure, deliberately: the true
                  result needs the shop-wide quantity at commit time, and
                  reimplementing the weighted average here would be a second
                  copy of the formula free to drift a cent from the one in the
                  migration. An honest direction beats a precise number that
                  can be wrong. The exception is stated in the note below --
                  with no cost recorded, or none in stock, there is nothing to
                  average against and the delivery's price lands exactly. */}
              {changes.length > 0 && (
                <>
                  <Text style={[styles.label, styles.labelSpaced]}>COSTS THIS DELIVERY WILL MOVE</Text>
                  <View style={styles.receipt}>
                    {changes.map((change) => (
                      <View key={`${change.productId}|${change.locationName}`} style={styles.receiptItem}>
                        <Text style={styles.receiptItemName} numberOfLines={2}>
                          {change.productName}
                          {plan.receipts.length > 1 ? ` · ${change.locationName}` : ''}
                        </Text>
                        <Text style={[styles.costChange, change.conflicting && styles.costChangeClash]}>
                          {change.previousCostCents === null
                            ? `no cost → ${formatCents(change.costCents)}`
                            : `${formatCents(change.previousCostCents)} → toward ${formatCents(change.costCents)}`}
                        </Text>
                      </View>
                    ))}
                  </View>
                  <Text style={styles.costBasisNote}>
                    Stock is valued at weighted average cost, so each delivery moves a product&apos;s cost part of the way
                    toward what you paid — by how much depends on how much you already hold. A product with no cost
                    recorded, or none in stock, takes the delivery&apos;s price exactly.
                  </Text>
                  {/* Said in words as well as coloured, because the rows on
                      their own look like two ordinary updates. There is one
                      cost column per product and no store dimension in it, so
                      both figures are averaged into the same column rather
                      than one of them winning. */}
                  {clashes.map((clash) => (
                    <Text key={clash.productId} style={styles.oversized}>
                      {clash.productName} is priced two ways in this sheet:{' '}
                      {changes
                        .filter((c) => c.productId === clash.productId)
                        .map((c) => `${formatCents(c.costCents)} at ${c.locationName}`)
                        .join(', ')}
                      . There is one cost per product, so both are averaged into it and the product ends up on a blend of
                      the two rather than on either — fix the sheet if that isn&apos;t what you meant.
                    </Text>
                  ))}
                </>
              )}
            </>
          )}

          {/* Warned about, never rejected: a pallet arriving really does look
              like a misplaced decimal point, and only the shop can tell them
              apart. So it is said out loud and the row still goes through. */}
          {plan.oversized.length > 0 && (
            <>
              <Text style={[styles.label, styles.labelSpaced]}>WORTH A SECOND LOOK</Text>
              {plan.oversized.map((entry: OversizedReceipt) => (
                <Text key={`${entry.productName}|${entry.locationName}`} style={styles.oversized}>
                  {entry.productName} at {entry.locationName}: {entry.quantity} arriving against {entry.held} held. Check it
                  isn&apos;t a decimal slip.
                </Text>
              ))}
            </>
          )}

          {plan.rejected.length > 0 && (
            <>
              <Text style={[styles.label, styles.labelSpaced]}>WHAT WON&apos;T</Text>
              {plan.rejected.slice(0, 8).map((row: RejectedRow) => (
                <View key={row.row} style={styles.rejectRow}>
                  <Text style={styles.rejectNumber}>Row {row.row}</Text>
                  <Text style={styles.rejectReason}>{row.reason}</Text>
                </View>
              ))}
              {plan.rejected.length > 8 && (
                <Text style={styles.empty}>…and {plan.rejected.length - 8} more, in the file below.</Text>
              )}
              <Pressable onPress={onDownloadRejected} style={styles.ghost}>
                <Text style={styles.ghostText}>
                  Download the {plan.rejected.length} rejected row{plan.rejected.length === 1 ? '' : 's'}
                </Text>
              </Pressable>
            </>
          )}
        </>
      )}
    </>
  );
}

function Pill({ tone, text }: { tone: 'ok' | 'bad' | 'warn' | 'acc'; text: string }) {
  return (
    <View style={[styles.pill, styles[`pill_${tone}`]]}>
      <Text style={[styles.pillText, styles[`pillText_${tone}`]]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: '88%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  segment: { flexDirection: 'row', backgroundColor: '#F2F2F2', borderRadius: 12, padding: 4, gap: 4, marginBottom: 16 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 9 },
  segmentItemActive: { backgroundColor: '#FFFFFF' },
  segmentText: { fontSize: 13, fontWeight: '700', color: '#6B6B73' },
  segmentTextActive: { color: '#111111' },
  body: { flexGrow: 0 },
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginBottom: 6 },
  labelSpaced: { marginTop: 16 },
  labelOptional: { fontWeight: '600', letterSpacing: 0 },
  // The same three properties pos.tsx needs on its category row, for the same
  // reason: without them Yoga sizes this container to the WHOLE chip list
  // rather than letting the row scroll, so a shop with a dozen categories
  // stretches the sheet instead of getting a sideways scroll.
  chipScroll: { flexGrow: 0, flexShrink: 0, minWidth: 0 },
  chips: { flexDirection: 'row', gap: 6, paddingRight: 8, paddingTop: 10 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  // The search box and, on web, the camera button beside it. One row so the
  // button cannot drift away from the field it belongs to.
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchField: { flex: 1 },
  scanPill: { backgroundColor: '#111111', borderRadius: 10, height: 42, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  scanPillText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12.5 },
  fieldRow: { flexDirection: 'row', gap: 8 },
  fieldHalf: { flex: 1 },
  help: { fontSize: 13, color: '#5E5D65', marginBottom: 10, lineHeight: 19 },
  helpStrong: { fontWeight: '800', color: '#111111' },
  notice: { fontSize: 12.5, fontWeight: '700', color: '#1B47B8', backgroundColor: '#E6EDFF', borderRadius: 10, padding: 10, marginTop: 14 },

  basket: { backgroundColor: '#F6F6F7', borderRadius: 14, padding: 12, marginTop: 16 },
  basketCap: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 2 },
  basketCapLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: '#6B6B73' },
  basketCapTotal: { fontSize: 12.5, fontWeight: '800', color: '#111111', fontVariant: ['tabular-nums'] },

  lineWrap: { borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  lineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 10 },
  lineText: { flex: 1 },
  lineName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  lineMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  lineMetaLow: { color: '#8A5806', fontWeight: '700' },
  lineMetaMissing: { fontSize: 12, color: '#A3202F', fontWeight: '700', marginTop: 2, lineHeight: 17 },
  add: { fontSize: 12, fontWeight: '800', color: '#111111' },
  remove: { alignSelf: 'flex-start', marginTop: 6 },
  removeText: { fontSize: 11.5, fontWeight: '700', color: '#9CA3AF' },
  empty: { fontSize: 13, color: '#9CA3AF', marginTop: 12 },

  qtyPair: { flexDirection: 'row', gap: 8 },
  cap: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6, color: '#9CA3AF', marginBottom: 3 },
  qtyInput: {
    backgroundColor: '#F2F2F2',
    borderRadius: 10,
    height: 38,
    width: 62,
    paddingHorizontal: 10,
    color: '#111111',
    fontWeight: '700',
    textAlign: 'right',
  },
  costInput: { width: 78 },

  // The sheet tab, borrowed wholesale from stock-transfer-modal.tsx so the two
  // sheets are visibly the same tool. A second set of pill colours would read
  // as a second feature.
  sheetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ghost: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: '#DCDCE4', alignSelf: 'flex-start', marginTop: 8 },
  ghostText: { color: '#111111', fontWeight: '800', fontSize: 12.5 },
  fileName: { fontSize: 12.5, color: '#5E5D65', marginTop: 10, fontWeight: '600' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  pill: { borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
  pill_ok: { backgroundColor: '#D9EFE4' },
  pill_bad: { backgroundColor: '#FBEAEC' },
  pill_warn: { backgroundColor: '#FDF1DA' },
  pill_acc: { backgroundColor: '#E6EDFF' },
  pillText: { fontSize: 12, fontWeight: '800' },
  pillText_ok: { color: '#007A38' },
  pillText_bad: { color: '#A3202F' },
  pillText_warn: { color: '#8A5806' },
  pillText_acc: { color: '#1B47B8' },
  // One block per store, unlike the move sheet's single line per pair: a
  // delivery is read against the invoice in the shop's hand, so the product
  // names and their quantities have to be on screen to be checked off.
  receipt: { backgroundColor: '#F6F6F7', borderRadius: 14, padding: 12, marginTop: 8 },
  receiptCap: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 4 },
  receiptName: { fontSize: 13, fontWeight: '800', color: '#111111', flexShrink: 1 },
  receiptMeta: { fontSize: 12, color: '#9CA3AF', fontVariant: ['tabular-nums'] },
  receiptItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 5 },
  receiptItemName: { fontSize: 12.5, color: '#5E5D65', flexShrink: 1 },
  receiptItemQty: { fontSize: 12.5, fontWeight: '800', color: '#111111', fontVariant: ['tabular-nums'] },
  // Same weight and figures as the quantity beside it -- a cost change is a
  // number the shop has to read at the same glance, not a footnote.
  costChange: { fontSize: 12.5, fontWeight: '800', color: '#111111', fontVariant: ['tabular-nums'] },
  // The same amber the oversized warning uses, so "look at this one" means one
  // thing on this screen.
  costChangeClash: { color: '#8A5806' },
  // Quiet, and below the rows rather than beside them: it qualifies every row
  // at once, and the IAS 2.36(a) disclosure of which formula is in use belongs
  // wherever a cost is shown, not only on Inventory's stock value.
  costBasisNote: { fontSize: 12, color: '#5E5D65', marginTop: 8, lineHeight: 17 },
  oversized: { fontSize: 12.5, fontWeight: '700', color: '#8A5806', backgroundColor: '#FDF1DA', borderRadius: 10, padding: 10, marginTop: 8, lineHeight: 18 },
  rejectRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  rejectNumber: { fontSize: 11, fontWeight: '800', color: '#A3202F', letterSpacing: 0.4 },
  rejectReason: { fontSize: 12.5, color: '#5E5D65', marginTop: 2, lineHeight: 18 },

  // The rule and the spacing moved up from the button row into this wrapper so
  // the inventory-purchase checkbox can sit inside the footer region, above the
  // buttons, rather than being squeezed into a row laid out for two things.
  footerWrap: { marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#DCDCE4', gap: 12 },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  checkBox: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, borderColor: '#DCDCE4', alignItems: 'center', justifyContent: 'center' },
  checkBoxOn: { backgroundColor: '#111111', borderColor: '#111111' },
  checkMark: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', lineHeight: 13 },
  checkLabel: { fontSize: 12.5, fontWeight: '700', color: '#5E5D65', flexShrink: 1 },
  footerTotal: { flex: 1 },
  footerTotalText: { fontSize: 13, fontWeight: '800', color: '#111111', fontVariant: ['tabular-nums'] },
  footerTotalHint: { fontSize: 11.5, fontWeight: '600', color: '#9CA3AF', marginTop: 1 },
  primary: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  primaryText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  disabled: { backgroundColor: '#CCCCCC' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 12 },
  // Same shape as `error`, in the green this file's own Pill already uses for
  // a positive reading (`pillText_ok`) -- mutually exclusive with it in
  // practice, since both `submit` and `commitPlan` clear one before the other
  // can be set for a given attempt.
  success: { color: '#007A38', fontSize: 13, fontWeight: '700', marginTop: 12 },
});
