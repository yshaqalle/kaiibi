import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { StoreDropdown } from '@/components/store-dropdown';
import { AppModal } from '@/components/ui/app-modal';
import { useAuth } from '@/hooks/use-auth';
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
  costUpdates,
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
// No scanning here, on any platform. Scanning was built into the Move sheet and
// taken back out the next day: the native key capture wraps the activity's
// window, and a React Native Modal on Android is a Dialog with a window of its
// own, so keys typed while a sheet is up never reach it -- and with nothing
// swallowing it, a scanner's trailing Enter presses whichever control holds
// focus. The web-only camera button is a later job, deliberately separate.

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
  const [catalogue, setCatalogue] = useState<Product[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Unticked, and it starts unticked again on every open (closeAndReset below).
  //
  // A shop that types its supplier invoices into Accounting separately would
  // otherwise double-count its spending, silently and forever -- and a
  // remembered tick is the same thing one open later. Opt-in is recoverable;
  // opt-out is not. Shared by both tabs because it is one question about this
  // delivery, but each tab decides for itself whether the question can even be
  // asked (see `handExpenseCents` and `planExpenseCents`).
  const [logExpense, setLogExpense] = useState(false);

  // Sheet tab
  const [sheetFile, setSheetFile] = useState<string | null>(null);
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([]);
  const [plan, setPlan] = useState<RestockPlan | null>(null);
  const [sheetNotice, setSheetNotice] = useState<string | null>(null);
  // Set only by a commitPlan that partially failed, and read only by the
  // footer. commitPlan empties plan.receipts on ANY failure so a re-press
  // cannot repeat a store that already went through (see commitPlan) -- but
  // that same clearing is what let the footer claim "nothing has changed
  // yet" directly under an error naming the store that just changed. This
  // remembers what actually went through, for display only; it plays no part
  // in the retry-safety logic below.
  const [partialReceipt, setPartialReceipt] = useState<{ units: number; stores: number } | null>(null);

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
        setLines((current) =>
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
  }, [visible, load]);

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
    setLines([]);
    setNote('');
    setSupplier('');
    setReference('');
    setSearch('');
    setCategory(null);
    setError(null);
    setPlan(null);
    setSheetFile(null);
    setSheetHeaders([]);
    setSheetNotice(null);
    setPartialReceipt(null);
    setLogExpense(false);
    setTab('hand');
    onClose();
  }, [onClose]);

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
    setLines((current) =>
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
    setLines((current) => current.map((l) => (l.product.id === productId ? { ...l, quantity: text } : l)));
  };

  const setCost = (productId: string, text: string) => {
    setLines((current) => current.map((l) => (l.product.id === productId ? { ...l, cost: text } : l)));
  };

  const removeLine = (productId: string) => {
    setLines((current) => current.filter((l) => l.product.id !== productId));
  };

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
  const logInventoryPurchase = async (locId: string, amountCents: number): Promise<string | null> => {
    try {
      await createExpense(shopId, {
        locationId: locId,
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
    try {
      await receiveStock(shopId, locationId, items, {
        supplierName: supplier.trim() || null,
        reference: reference.trim() || null,
        note: note.trim() || null,
      });
      // Only after the units are in, and only if the offer was actually on
      // screen -- `handExpenseCents` is re-read here rather than trusting
      // `logExpense` alone, because the tick survives an edit that unprices a
      // line and the checkbox merely disappearing must not leave a stale yes.
      const expenseProblem =
        logExpense && handExpenseCents !== null ? await logInventoryPurchase(locationId, handExpenseCents) : null;
      await onDone();
      if (expenseProblem) {
        // The delivery is IN. So the basket is emptied -- pressing Receive
        // again would receive the same units a second time, and the button is
        // still sitting there -- but the sheet stays open carrying the one
        // sentence that says what happened and what is left to do by hand.
        // Closing here would show the message for no time at all.
        setLines([]);
        setNote('');
        setError(`The stock was received, but the expense was not logged: ${expenseProblem}`);
        setBusy(false);
        return;
      }
      closeAndReset();
    } catch (err) {
      // receive_stock is gated by enforce_shop_module('inventory'), which
      // raises the literal string "module_not_included" -- describePlanError
      // turns that (and a limit-reached error) into a sentence before the
      // generic fallback ever sees it. Same precedent as the sibling
      // (stock-transfer-modal.tsx's local extractErrorMessage).
      setError(describePlanError(err) ?? extractErrorMessage(err));
      setBusy(false);
    }
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
                return column.header === 'Quantity received' ? String(chosen.quantity) : chosen.cost;
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
    setSheetFile(picked.fileName);
    setSheetHeaders(picked.parsed.headers);
    setPlan(next);

    // A sheet that turns out to be one store is the same thing the by-hand tab
    // holds, so it lands there -- where a number can still be changed before
    // anything is received. More than one store has no single destination to
    // show, so it stays here as a summary.
    if (next.receipts.length === 1 && next.rejected.length === 0) {
      const receipt = next.receipts[0];
      const byId = new Map(products.map((p) => [p.id, p]));
      setLocationId(receipt.locationId);
      setLines(
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
        await receiveStock(
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
            const problem = await logInventoryPurchase(receipt.locationId, cents);
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
    await onDone();
    setBusy(false);
    if (failures.length > 0 || expenseProblems.length > 0) {
      // The plan stays on screen: the stores that DID go through have already
      // received, so re-pressing must not repeat them. The shop reads which
      // store failed and fixes that section of the sheet.
      //
      // An expense problem alone lands here for the same reason and gets the
      // same treatment -- the stock is in, so the spent plan is cleared and
      // the sentence says which store's expense is left to add by hand.
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
      setPlan({ ...plan, receipts: [] });
      // Remembered for the footer, which otherwise has nothing left to read
      // "nothing has changed yet" against -- receipts is now empty on
      // purpose (see above), but the stores in `succeeded` already changed.
      setPartialReceipt(
        succeeded.length > 0
          ? { units: succeeded.reduce((sum, receipt) => sum + receivedUnits(receipt), 0), stores: succeeded.length }
          : null
      );
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
                    Import instead. */}
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search by name, SKU or barcode"
                  placeholderTextColor="#999999"
                  style={styles.input}
                />
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
                        ? `to ${partialReceipt.stores} store${partialReceipt.stores === 1 ? '' : 's'} before the failure above`
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
}: {
  line: Line;
  onQuantity: (text: string) => void;
  onCost: (text: string) => void;
  onRemove: () => void;
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
            <TextInput
              // The typed text itself. Emptying it leaves an empty field and a
              // row that stays put with its unit cost intact; the footer says
              // what is missing and the commit waits.
              value={line.quantity}
              onChangeText={onQuantity}
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
            <TextInput
              value={line.cost}
              onChangeText={onCost}
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
  const costChanges = plan ? costUpdates(plan) : [];

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
            {costChanges.length > 0 && (
              <Pill tone="acc" text={`${costChanges.length} cost${costChanges.length === 1 ? '' : 's'} updated`} />
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
});
