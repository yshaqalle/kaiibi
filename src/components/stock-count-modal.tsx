import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { StoreDropdown } from '@/components/store-dropdown';
import { AppModal } from '@/components/ui/app-modal';
import { useAuth } from '@/hooks/use-auth';
import { listCategories } from '@/lib/categories';
import { extractErrorMessage } from '@/lib/checkout-errors';
import { rowsToCsv } from '@/lib/csv';
import {
  COUNT_REASONS,
  COUNT_SHEET_COLUMNS,
  COUNT_TEMPLATE_COLUMNS,
  countSheetRows,
  planCount,
  planLines,
  reasonLabel,
  summariseCount,
  type CountPlan,
  type CountSheetRow,
  type CountSummary,
  type PlannedCount,
  type PlannedCountLine,
} from '@/lib/count-import';
import { formatCents } from '@/lib/currency';
import { describePlanError } from '@/lib/entitlements';
import { createExpense } from '@/lib/expenses';
import { shareCsv } from '@/lib/export-file';
import { downloadRejectedRowsCsv, type RejectedRow } from '@/lib/import-shared';
import { toDateColumn } from '@/lib/period';
import { pickCsvFile } from '@/lib/pick-csv-file';
import { isUncosted } from '@/lib/product-costing';
import { listProducts, saveStockCount } from '@/lib/products';
import { readCountedQuantity } from '@/lib/restock-typed-input';
import type { NewExpenseInput, Product, StockCountReason } from '@/types/models';

// A stock-take, by hand or by spreadsheet.
//
// The sibling of StockRestockModal, and deliberately the same shape: a store
// picker, a search row, rows you type a number into, a running summary, one
// commit button, the same two tabs. A shop that has received a delivery once
// can count a shelf without reading anything.
//
// Two differences, and both follow from the fact that the number typed here is
// a TOTAL rather than an amount:
//
//  1. The field is PRE-FILLED with what the app believes. Restock's quantity
//     starts empty, because zero received is the honest default. A stock-take
//     mostly confirms, so a row left untouched means "I looked, it matched" --
//     real information, and the reason the footer counts three counted while
//     only two change anything.
//  2. The VARIANCE is a column, not a footnote. The person doing the count does
//     not need to be told the 8 they just counted. What they need to see, and
//     what they will be asked about, is how far off the app was.
//
// Not built here, deliberately: scanning. The mockup does not propose it, and
// the equivalent work on the restock sheet cost a CRITICAL to get right -- a
// scan landing in a number field while the same product's row was focused read
// the barcode as the quantity. Inventory's own wedge still stands down for the
// whole time this sheet is open (inventory.tsx's `enabled`), so a scan fired
// here does nothing rather than something wrong.

type Tab = 'hand' | 'sheet';
// `counted` is the RAW string the person typed, never a parsed number and never
// rewritten on the way in. See restock-typed-input.ts for why that is the whole
// design of this screen's input handling.
type Line = { product: Product; counted: string; reason: StockCountReason | null };
type LineReading = { line: Line; counted: number | null; variance: number | null };

export function StockCountModal({ visible, shopId, onClose, onDone }: {
  visible: boolean;
  shopId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { locations, activeLocation } = useAuth();
  const selectable = useMemo(() => locations.filter((location) => location.active), [locations]);

  const [tab, setTab] = useState<Tab>('hand');
  const [chosenLocationId, setLocationId] = useState<string | null>(activeLocation?.id ?? selectable[0]?.id ?? null);
  // Resolved on read rather than repaired in an effect: the initial value is
  // computed once, at first mount, which can be before the session's locations
  // have arrived -- and a one-store shop cannot correct it, because
  // StoreDropdown renders nothing for it.
  const locationId = chosenLocationId ?? activeLocation?.id ?? selectable[0]?.id ?? null;
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  // Every basket write goes through one helper that runs its updater
  // immediately and stores the result in both the ref and the state, so a
  // handler reading the basket never reads a render behind.
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
  // Which line's reason chips are expanded, by product id. Inline, never a
  // second modal: a sheet opened from a sheet is dropped by iOS without a word
  // and needs useStagedSheet to survive -- five chips that unfold under the row
  // avoid the whole class, and a reason is a five-way choice, not a screen.
  const [reasonOpenFor, setReasonOpenFor] = useState<string | null>(null);
  const [logExpense, setLogExpense] = useState(false);

  // Sheet tab
  const [sheetFile, setSheetFile] = useState<string | null>(null);
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([]);
  const [plan, setPlan] = useState<CountPlan | null>(null);
  const [sheetNotice, setSheetNotice] = useState<string | null>(null);
  // Set only by a commitPlan that partially failed, and read only by the
  // footer. commitPlan empties plan.counts on ANY failure so a re-press cannot
  // repeat a store that already went through -- but that same clearing is what
  // let the restock footer claim "nothing has changed yet" directly under an
  // error naming the store that just changed.
  const [partialCount, setPartialCount] = useState<{ lines: number; stores: number } | null>(null);

  // Scoped to the store being counted, because "App says 11" is the number the
  // whole screen is about. Unlike Restock, the shop-wide list is NOT merged in:
  // a stock-take walks a room, and a product this store does not carry has no
  // shelf to walk to. listProducts(shopId, locationId) already draws exactly
  // that line and keeps rows sitting at zero.
  const load = useCallback(async () => {
    if (!locationId) return [] as Product[];
    return listProducts(shopId, locationId);
  }, [shopId, locationId]);

  // The basket is re-pointed at the reloaded rows as well as the picker: a line
  // keeps a whole Product snapshot taken when it was added, and "App says" is
  // read off that snapshot. Only `product` is replaced -- the typed count and
  // the chosen reason are the person's, not the server's.
  //
  // EXCEPT when `locationId` itself has just changed. A typed `counted`
  // string is a claim about a specific shelf -- "App says 11, I found 8" --
  // and that claim does not carry to a different store just because the two
  // happen to stock a product with the same id. Re-pointing `product` alone
  // (the old behaviour) left the stale `counted` in place: change the store
  // from one holding 11 to one holding 3 and the row silently became "found
  // 11 at a shelf nobody walked", ready to overwrite the new store's real
  // count on Save. Losing the basket is the correct outcome of a store
  // change; carrying it forward is the bug.
  //
  // `lastLocationRef` is what tells an actual transition apart from this
  // effect's ordinary re-runs (first mount, a product added mid-session
  // triggering a reload) -- both of which must NOT clear a basket someone is
  // mid-typing. It starts equal to the initial `locationId`, so mount never
  // reads as a change, and it is only ever compared against the `locationId`
  // this render closed over, which is exactly the value `load` was rebuilt
  // for.
  const lastLocationRef = useRef(locationId);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const storeChanged = lastLocationRef.current !== locationId;
    lastLocationRef.current = locationId;
    if (storeChanged) {
      updateLines(() => []);
      setReasonOpenFor(null);
    }
    load()
      .then((rows) => {
        if (!active) return;
        setCatalogue(rows);
        // The basket was just emptied above -- nothing left to re-point.
        if (storeChanged) return;
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
  }, [visible, load, updateLines, locationId]);

  useEffect(() => {
    if (!visible) return;
    listCategories(shopId)
      .then((rows) => setCategories(rows.map((r) => r.name)))
      .catch(() => {});
  }, [visible, shopId]);

  // Closing has to put everything back, because this component is never
  // unmounted -- the screen renders it with visible={false} and it returns
  // null, keeping all of its state.
  const closeAndReset = useCallback(() => {
    setBusy(false);
    updateLines(() => []);
    setNote('');
    setSearch('');
    setCategory(null);
    setError(null);
    setReasonOpenFor(null);
    setLogExpense(false);
    setPlan(null);
    setSheetFile(null);
    setSheetHeaders([]);
    setSheetNotice(null);
    setPartialCount(null);
    setTab('hand');
    onClose();
  }, [onClose, updateLines]);

  // PRE-FILLED, and this is the difference the whole screen turns on. Restock
  // seeds "1" because a delivery is at least one unit; a count seeds what the
  // app already holds, because most lines of a stock-take confirm it. Left
  // alone, the row reads as "I looked, it matched" and still counts.
  const addLine = (product: Product) => {
    updateLines((current) =>
      current.some((l) => l.product.id === product.id)
        ? current
        : [...current, { product, counted: String(product.stock), reason: null }]
    );
  };

  // Stores the keystrokes and nothing else. Rewriting text inside onChangeText
  // on a controlled input cannot work: the rewritten string is what the NEXT
  // keystroke is appended to, so a number is reinterpreted before it has
  // finished being typed. The row is NOT dropped at zero, and not at an empty
  // field either -- one backspace unmounting the focused input would close the
  // keyboard and take the reason chosen beside it. readCountedQuantity returns
  // null for an empty field, the commit is blocked, and the footer says why.
  const setCounted = (productId: string, text: string) => {
    updateLines((current) => current.map((l) => (l.product.id === productId ? { ...l, counted: text } : l)));
  };

  // Picking the reason a line already carries clears it, so a mis-tap is
  // undoable without a sixth "None" chip pretending to be a reason.
  const setReason = (productId: string, reason: StockCountReason) => {
    updateLines((current) =>
      current.map((l) => (l.product.id === productId ? { ...l, reason: l.reason === reason ? null : reason } : l))
    );
    setReasonOpenFor(null);
  };

  const removeLine = (productId: string) => {
    updateLines((current) => current.filter((l) => l.product.id !== productId));
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
    () =>
      lines.map((line) => {
        const counted = readCountedQuantity(line.counted);
        return { line, counted, variance: counted === null ? null : counted - line.product.stock };
      }),
    [lines]
  );
  const everyCountReads = readings.every((reading) => reading.counted !== null);

  // The plan this basket amounts to, in exactly the shape the sheet tab builds
  // -- so one summariseCount serves both tabs and the two can never disagree
  // about what "2 differ" or "$13.83 of shortfall" means.
  //
  // Empty until every field reads, because a summary computed over half a
  // basket is a smaller number presented as the whole thing. `readings.length`
  // is checked separately in `canSubmit` below and NOT relied on here: `every`
  // on an empty array is true, so an empty basket produces an empty plan and a
  // summary of zeroes -- honest for a footer, and refused by the button.
  const handLines: PlannedCountLine[] = useMemo(
    () =>
      everyCountReads
        ? readings.map((reading) => ({
            productId: reading.line.product.id,
            productName: reading.line.product.name,
            previousQuantity: reading.line.product.stock,
            countedQuantity: reading.counted!,
            variance: reading.variance!,
            reason: reading.line.reason,
            unitCostCents: isUncosted(reading.line.product) ? null : reading.line.product.costCents,
          }))
        : [],
    [readings, everyCountReads]
  );
  const handSummary = useMemo(() => summariseCount(handLines), [handLines]);

  const canSubmit = Boolean(locationId) && readings.length > 0 && everyCountReads && !busy;

  // After the count, never before: an expense for a stock-take that failed to
  // land is a number in the P&L with no missing stock behind it. This never
  // throws and never closes anything -- it RETURNS what went wrong so the
  // caller can say so while keeping the count, because the numbers really did
  // change and rolling them back to punish a failed expense loses the more
  // important of the two. (Returning rather than calling setError is what makes
  // that possible: both callers finish by resetting, which would wipe the
  // message.)
  const logStockLoss = async (locId: string, amountCents: number): Promise<string | null> => {
    try {
      await createExpense(shopId, {
        locationId: locId,
        // Local date, not toISOString().slice(0, 10) -- an evening stock-take
        // west of Greenwich would otherwise land in tomorrow's P&L.
        occurredOn: toDateColumn(new Date()),
        amountCents,
        category: 'stock_loss',
        vendorId: null,
        // There is no counterparty and nothing was paid today; `cash` is the
        // column's default and the only honest thing to put in a field that
        // does not apply. The note is what carries the meaning.
        paymentMethod: 'cash',
        note: note.trim() ? `Stock-take — ${note.trim()}` : 'Stock-take',
      } satisfies NewExpenseInput);
      return null;
    } catch (err) {
      return extractErrorMessage(err);
    }
  };

  const submit = async () => {
    if (!canSubmit || !locationId) return;
    setBusy(true);
    setError(null);
    // ONLY the write is inside the try, and the try ends the moment it
    // resolves. Everything after this point runs against a count that has
    // already committed, so nothing after it may reach a catch that leaves the
    // basket standing. On the restock sheet it did: `await onDone()` sat here,
    // onDone is the Inventory screen's reload, and a reload throwing on a
    // network blip landed in this catch -- an error beside a full basket and a
    // live Save button. Pressing it wrote the same count a second time.
    try {
      await saveStockCount(
        shopId,
        locationId,
        handLines.map((line) => ({
          productId: line.productId,
          countedQuantity: line.countedQuantity,
          reason: line.reason,
        })),
        { note: note.trim() || null }
      );
    } catch (err) {
      // save_stock_count is gated by enforce_shop_module('inventory'), which
      // raises the literal string "module_not_included" -- describePlanError
      // turns that into a sentence before the generic fallback sees it. It also
      // raises "not authorized for shop ..." for a member without
      // inventory.count, which extractErrorMessage passes through as written.
      //
      // Nothing was counted, so the basket is deliberately left exactly as it
      // is: this is the one failure a shop fixes by pressing again.
      setError(describePlanError(err) ?? extractErrorMessage(err));
      setBusy(false);
      return;
    }

    // The numbers are IN. The basket is spent from here on, and it is emptied
    // before anything that can fail.
    updateLines(() => []);
    setNote('');
    setLogExpense(false);

    // Only after the numbers are in, and only if the offer was actually on
    // screen. `handSummary.shortfallCents` is re-read here rather than trusting
    // `logExpense` alone, because the tick survives an edit that turns a
    // shortfall into a match, and a checkbox merely disappearing must not leave
    // a stale yes behind it.
    const shortfall = handSummary.shortfallCents;
    const expenseProblem =
      logExpense && shortfall !== null && shortfall > 0 ? await logStockLoss(locationId, shortfall) : null;
    // Swallowed on purpose: the caller's list refresh is not part of the
    // stock-take, and treating its failure as this screen's failure is what
    // produced the double-commit above.
    await onDone().catch(() => {});
    if (expenseProblem) {
      // The sheet stays open carrying the one sentence that says what happened
      // and what is left to do by hand. The basket is already empty, so the
      // button still on screen cannot count the same shelf again.
      setError(`The count was saved, but the stock loss was not logged: ${expenseProblem}`);
      setBusy(false);
      return;
    }
    closeAndReset();
  };

  // --- the sheet tab ------------------------------------------------------

  // Everything every store carries, once. Three things need it: the download
  // states each count and each shelf, the sort walks the shelves, and the
  // preview compares each counted total against what the store holds now.
  //
  // `listProducts(shopId, locationId)` already resolves the store's own
  // shelf_number override (products.ts:112) as well as its stock, so the shelf
  // on the sheet is the shelf in THAT branch -- which is the whole reason the
  // column is per store rather than per product.
  const loadHoldings = useCallback(async (): Promise<{ byStore: Map<string, Product[]>; stockAt: Map<string, number> }> => {
    const byStore = new Map<string, Product[]>();
    const stockAt = new Map<string, number>();
    await Promise.all(
      selectable.map(async (location) => {
        const held = await listProducts(shopId, location.id);
        byStore.set(location.id, held);
        for (const product of held) stockAt.set(`${product.id}|${location.id}`, product.stock);
      })
    );
    return { byStore, stockAt };
  }, [shopId, selectable]);

  // Every store's own holdings, sorted for the walk. Rows already in the basket
  // come back pre-filled, so a shop that starts by hand and realises it is a
  // bigger job than it thought does not retype them.
  const downloadSheet = async () => {
    setBusy(true);
    setError(null);
    try {
      const { byStore } = await loadHoldings();
      const rows = countSheetRows(
        selectable,
        selectable.flatMap((location) =>
          (byStore.get(location.id) ?? []).map((product) => ({
            product,
            location,
            stock: product.stock,
            shelfNumber: product.shelfNumber,
          }))
        )
      );
      const columns = COUNT_SHEET_COLUMNS.map((column) =>
        column.header === 'Counted' || column.header === 'Reason'
          ? {
              header: column.header,
              value: (row: CountSheetRow) => {
                // Only the row for the store the basket is counting -- the same
                // product's row at another branch was not what was counted, and
                // pre-filling it would set that branch's shelf to a number
                // nobody walked to.
                const chosen =
                  row.location.id === locationId
                    ? lines.find((l) => l.product.id === row.product.id)
                    : undefined;
                if (!chosen) return '';
                // `counted` is already the raw string the person typed -- see
                // the Line type. It needs no converting on the way out.
                return column.header === 'Counted' ? chosen.counted : chosen.reason ? reasonLabel(chosen.reason) : '';
              },
            }
          : column
      );
      await shareCsv(rowsToCsv(rows, columns), 'count-sheet.csv', 'Count sheet');
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const uploadSheet = async () => {
    setError(null);
    setSheetNotice(null);
    const picked = await pickCsvFile(COUNT_TEMPLATE_COLUMNS);
    if (picked.status === 'cancelled') return;
    if (picked.status === 'error') {
      setError(picked.message);
      return;
    }
    const products = await listProducts(shopId);
    const { byStore, stockAt } = await loadHoldings();

    const next = planCount(picked.parsed, {
      products,
      locations: selectable,
      // The LIVE figure, not the sheet's own "App says" column, which was true
      // when the file was downloaded. The RPC reads it a third time under a row
      // lock at commit, and that reading is the one recorded.
      stockAt: (productId, locId) => stockAt.get(`${productId}|${locId}`) ?? 0,
    });
    // A fresh upload is a fresh attempt -- without this, re-uploading to retry
    // the rest after a partial failure would leave the previous attempt's
    // "N lines already counted" banner sitting under a brand new preview.
    setPartialCount(null);

    // A sheet that turns out to be one store is the same thing the by-hand tab
    // holds, so it lands there -- where a number can still be changed before
    // anything is written.
    const handedOver = next.counts.length === 1 && next.rejected.length === 0;
    // The plan is DROPPED when it is handed over, not merely stepped away
    // from. Left standing on the restock sheet it sat behind the `By sheet`
    // tab as a live preview of the ORIGINAL file with the button still
    // enabled, so a shop that corrected 8 to 12 on the by-hand tab and glanced
    // back could commit the 8 the file said.
    setSheetFile(handedOver ? null : picked.fileName);
    setSheetHeaders(handedOver ? [] : picked.parsed.headers);
    setPlan(handedOver ? null : next);

    if (handedOver) {
      const count = next.counts[0];
      // Scoped to THAT store, so each basket row's "App says" is the branch the
      // sheet counted rather than whichever store the dropdown was showing.
      const byId = new Map((byStore.get(count.locationId) ?? []).map((p) => [p.id, p]));
      setLocationId(count.locationId);
      // Told apart from a user picking a different store in the dropdown: THIS
      // change is the handover moving the plan's own store into the basket, not
      // someone stepping away from a shelf they were mid-typing. Without this,
      // the store-transition guard above (`lastLocationRef`) reads the
      // programmatic `setLocationId` as exactly that kind of transition and
      // empties the basket the handover just filled -- on the very next
      // render, before anyone sees it. This makes `storeChanged` read false
      // for the render the handover causes, while a genuine dropdown pick
      // still lands on the effect's own assignment and clears as before.
      lastLocationRef.current = count.locationId;
      updateLines(() =>
        count.lines.flatMap((line) =>
          byId.has(line.productId)
            ? [{
                product: byId.get(line.productId)!,
                // The basket field holds the RAW string a person typed, so a
                // planned number is turned back into text on the way in.
                counted: String(line.countedQuantity),
                reason: line.reason,
              }]
            : []
        )
      );
      setSheetNotice(
        `${picked.fileName} — ${count.lines.length} line${count.lines.length === 1 ? '' : 's'} ready. Change anything before saving.`
      );
      setTab('hand');
    }
  };

  // The plan's own summary, computed by the same function the basket's is --
  // so "2 differ" and a shortfall value mean one thing on both tabs. Declared
  // here, above `commitPlan`, rather than beside `canCommitPlan` below it:
  // `commitPlan` reads it (see `offered`, in the loop below) and a function
  // reading a `useMemo` declared after it in source order is what broke React
  // Compiler's manual-memoization check the first time this was written.
  const planSummary = useMemo(() => summariseCount(plan ? planLines(plan) : []), [plan]);

  // One save_stock_count call per store. A store that fails fails whole and is
  // named; the others still go through, because rolling back good work for a
  // problem the shop can fix by re-uploading one section helps nobody.
  const commitPlan = async () => {
    if (!plan || plan.counts.length === 0) return;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    // Kept apart from `failures`, which heads its error with "Some of the count
    // did not go through". A logged-expense failure is the opposite case -- all
    // of the count went through and a bookkeeping row did not -- and folding the
    // two together would tell a shop its stock-take failed when it did not.
    const expenseProblems: string[] = [];
    const succeeded: PlannedCount[] = [];
    // Read once, from what was actually ON SCREEN for this plan -- exactly
    // `submit`'s idiom, applied to the sheet's own aggregate rather than the
    // basket's. `uncostedShortfallLines` is computed across every store, so
    // `planSummary.shortfallCents` goes null (and the checkbox itself
    // disappears, replaced by the "no cost recorded" sentence) the moment ANY
    // store has an uncosted short line -- while `logExpense` alone would still
    // read true from before that line was uploaded or a tab switch happened.
    // Trusting `logExpense` alone here would write an expense for a store that
    // never had a checkbox offering it.
    const offered = logExpense && planSummary.shortfallCents !== null && planSummary.shortfallCents > 0;
    for (const count of plan.counts) {
      try {
        await saveStockCount(
          shopId,
          count.locationId,
          count.lines.map((line) => ({
            productId: line.productId,
            countedQuantity: line.countedQuantity,
            reason: line.reason,
          })),
          { note: note.trim() || null }
        );
        succeeded.push(count);
        // Per store, not one lump. Each store's count is its own stock-take,
        // and per-store reporting (migration 20260816000000) would otherwise
        // attribute the whole loss to whichever store happened to be first.
        // `logStockLoss` cannot throw, which matters here: an expense failure
        // reaching the catch below would name this store as one whose count did
        // not go through, when it did.
        if (offered) {
          const storeShortfall = summariseCount(count.lines).shortfallCents;
          if (storeShortfall !== null && storeShortfall > 0) {
            const problem = await logStockLoss(count.locationId, storeShortfall);
            if (problem) expenseProblems.push(`${count.locationName}: ${problem}`);
          }
        }
      } catch (err) {
        // Same RPC and same gates as the by-hand submit, so a plan-gated shop
        // and a member without inventory.count both read the same sentence
        // here that they would read there.
        failures.push(`${count.locationName}: ${describePlanError(err) ?? extractErrorMessage(err)}`);
      }
    }
    // The loop is over, so this list is SPENT -- every store in it either
    // counted or failed whole, and a store that failed is fixed by editing that
    // section of the sheet and uploading it again, never by pressing this
    // button a second time. Emptied here, before anything that can throw.
    setPlan({ ...plan, counts: [] });
    setPartialCount(
      succeeded.length > 0
        ? { lines: succeeded.reduce((sum, count) => sum + count.lines.length, 0), stores: succeeded.length }
        : null
    );
    await onDone().catch(() => {});
    setBusy(false);
    if (failures.length > 0 || expenseProblems.length > 0) {
      // An expense problem alone lands here too -- the numbers are in, so the
      // plan is spent either way, and the sentence says which store's stock
      // loss is left to add by hand. Kept separate from `failures`, which heads
      // its error with "Some of the count did not go through": folding the two
      // together would tell a shop its stock-take failed when it did not.
      setError(
        [
          failures.length > 0 ? `Some of the count did not go through.\n${failures.join('\n')}` : null,
          expenseProblems.length > 0
            ? `The count was saved, but the stock loss was not logged:\n${expenseProblems.join('\n')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n\n')
      );
      return;
    }
    closeAndReset();
  };

  const downloadRejected = async () => {
    if (!plan || plan.rejected.length === 0) return;
    await downloadRejectedRowsCsv(plan.rejected, sheetHeaders, 'count-rejected.csv');
  };

  const canCommitPlan = Boolean(plan) && (plan?.counts.length ?? 0) > 0 && !busy;

  if (!visible) return null;

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={closeAndReset}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Count</Text>
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
            <Text style={styles.label}>COUNTING AT</Text>
            <StoreDropdown
              value={locationId}
              onChange={setLocationId}
              allowAll={false}
              variant="field"
              title="Count stock at"
              placeholder="Choose a store"
            />

            {tab === 'hand' ? (
              <>
                {/* Set by an upload that turned out to be one store, which
                    lands here rather than staying on the sheet tab. Without it
                    the basket would fill from nowhere with no explanation. */}
                {sheetNotice ? <Text style={styles.notice}>{sheetNotice}</Text> : null}

                <Text style={[styles.label, styles.labelSpaced]}>ADD PRODUCTS</Text>
                {/* Deliberately not ScanSafeField -- no scan path is offered here,
                    and wrapping a field in a scan guard that can never fire is a
                    component pretending to do something. */}
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search by name, SKU or barcode…"
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
                    {search.trim() ? 'Nothing here matches that.' : 'Search above to add what you are counting.'}
                  </Text>
                )}

                {lines.length > 0 && (
                  <View style={styles.basket}>
                    {readings.map((reading) => (
                      <LineRow
                        key={reading.line.product.id}
                        line={reading.line}
                        variance={reading.variance}
                        reasonOpen={reasonOpenFor === reading.line.product.id}
                        onToggleReason={() =>
                          setReasonOpenFor((current) =>
                            current === reading.line.product.id ? null : reading.line.product.id
                          )
                        }
                        onCounted={(text) => setCounted(reading.line.product.id, text)}
                        onReason={(reason) => setReason(reading.line.product.id, reason)}
                        onRemove={() => removeLine(reading.line.product.id)}
                      />
                    ))}
                  </View>
                )}

                <Text style={[styles.label, styles.labelSpaced]}>NOTE</Text>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Anything worth recording about this stock-take"
                  placeholderTextColor="#999999"
                  style={styles.input}
                />
              </>
            ) : (
              <SheetTab
                fileName={sheetFile}
                plan={plan}
                planSummary={planSummary}
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
                about the stock-take, and a shop should read it on the way to
                the button whose meaning it changes. */}
            <StockLossCheck
              cents={(tab === 'hand' ? handSummary : planSummary).shortfallCents}
              uncostedShortfallLines={(tab === 'hand' ? handSummary : planSummary).uncostedShortfallLines}
              on={logExpense}
              onToggle={() => setLogExpense((ticked) => !ticked)}
            />
            {tab === 'hand' ? (
              <>
                {/* Gated on `everyCountReads` as well as a non-empty basket: with
                    one line counted and one blank, `handLines` is `[]` (see the
                    comment above it) and every figure here would read as zero
                    sitting directly under a live per-line variance -- a
                    contradiction, not an honest partial total. The empty-basket
                    case (`lines.length === 0`) is still allowed through as
                    zeroes, which is the honest reading of nothing counted yet. */}
                {lines.length > 0 && everyCountReads && (
                  <View style={styles.basket}>
                    <View style={styles.basketCap}>
                      <Text style={styles.basketCapLabel}>VARIANCE</Text>
                      <Text style={styles.basketCapTotal}>
                        {`${varianceText(handSummary.varianceUnits)} · ${varianceMoneyText(handSummary.varianceCents)}`}
                      </Text>
                    </View>
                    <Text style={styles.lineMeta}>
                      {`${handSummary.counted} counted · ${handSummary.matched} matched · ${handSummary.differ} differ. Nothing changes until you press Save.`}
                    </Text>
                  </View>
                )}
                <View style={styles.footerRow}>
                  <View style={styles.footerTotal}>
                    <Text style={styles.footerTotalText}>
                      {`Save ${readings.length} count${readings.length === 1 ? '' : 's'}`}
                    </Text>
                    <Text style={styles.footerTotalHint}>{countHint(readings, handSummary)}</Text>
                  </View>
                  <Pressable
                    onPress={submit}
                    disabled={!canSubmit}
                    style={[styles.primary, !canSubmit && styles.disabled]}
                    accessibilityLabel="Save counts"
                  >
                    <Text style={styles.primaryText}>{busy ? 'Saving…' : 'Save counts'}</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <View style={styles.footerRow}>
                <View style={styles.footerTotal}>
                  <Text style={styles.footerTotalText}>
                    {partialCount
                      ? `${partialCount.lines} line${partialCount.lines === 1 ? '' : 's'} already counted`
                      : plan
                        ? `${planSummary.counted} counted`
                        : 'No sheet yet'}
                  </Text>
                  <Text style={styles.footerTotalHint}>
                    {partialCount
                      ? `to ${partialCount.stores} store${partialCount.stores === 1 ? '' : 's'} before the failure above`
                      : plan
                        ? `across ${plan.counts.length} store${plan.counts.length === 1 ? '' : 's'} · nothing has changed yet`
                        : 'Download, fill it in, upload it back'}
                  </Text>
                </View>
                <Pressable
                  onPress={commitPlan}
                  disabled={!canCommitPlan}
                  style={[styles.primary, !canCommitPlan && styles.disabled]}
                  accessibilityLabel="Save counts"
                >
                  <Text style={styles.primaryText}>{busy ? 'Saving…' : 'Save counts'}</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </View>
    </AppModal>
  );
}

// The typographic minus, not a hyphen -- it is the same glyph the mockup uses
// and it lines up under tabular figures, which a hyphen does not.
function varianceText(variance: number | null): string {
  if (variance === null) return '—';
  if (variance === 0) return '0';
  return variance > 0 ? `+${variance}` : `−${Math.abs(variance)}`;
}

// `formatCents` puts the sign inside the digits -- `formatCents(-461)` is
// `$-4.61` -- which reads as a typo next to the U+2212 minus `varianceText`
// above already uses for the unit count. `formatAccountingCents`'s default
// style has the same problem with an ASCII hyphen instead (`-$4.61`), and its
// `parens` style is for a P&L, not a phone footer. The design of record
// (docs/design/inventory-count-mockup.html) reads `−$4.61`, so this takes the
// magnitude and prefixes the same minus by hand.
function varianceMoneyText(cents: number | null): string {
  if (cents === null) return 'value withheld';
  const magnitude = formatCents(Math.abs(cents));
  return cents < 0 ? `−${magnitude}` : magnitude;
}

// The line under the count, which is also the only place a blocked commit is
// explained. Ordered by what the person has to do next.
function countHint(readings: LineReading[], summary: CountSummary): string {
  if (readings.length === 0) return 'Nothing counted yet';
  if (readings.some((reading) => reading.counted === null)) return 'Type what you found on every line';
  return `${summary.differ} will change a number`;
}

function MatchRow({ product, onAdd }: { product: Product; onAdd: () => void }) {
  return (
    <Pressable
      onPress={onAdd}
      style={styles.lineWrap}
      accessibilityRole="button"
      accessibilityLabel={`Count ${product.name}`}
    >
      <View style={styles.lineRow}>
        <View style={styles.lineText}>
          <Text style={styles.lineName}>{product.name}</Text>
          <Text style={styles.lineMeta}>{`App says ${product.stock}`}</Text>
        </View>
        <Text style={styles.add}>Count</Text>
      </View>
    </Pressable>
  );
}

function LineRow({
  line,
  variance,
  reasonOpen,
  onToggleReason,
  onCounted,
  onReason,
  onRemove,
}: {
  line: Line;
  variance: number | null;
  reasonOpen: boolean;
  onToggleReason: () => void;
  onCounted: (text: string) => void;
  onReason: (reason: StockCountReason) => void;
  onRemove: () => void;
}) {
  const varianceStyle =
    variance === null || variance === 0
      ? styles.lineMeta
      : variance > 0
        ? styles.varianceUp
        : styles.varianceDown;
  return (
    <View style={styles.lineWrap}>
      <View style={styles.lineRow}>
        <View style={styles.lineText}>
          <Text style={styles.lineName}>{line.product.name}</Text>
          <Text style={styles.lineMeta}>{`App says ${line.product.stock}`}</Text>
          <Pressable onPress={onRemove} style={styles.remove} accessibilityRole="button">
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        </View>
        <View style={styles.qtyPair}>
          <View>
            <Text style={styles.cap}>COUNTED</Text>
            <TextInput
              value={line.counted}
              onChangeText={onCounted}
              keyboardType="number-pad"
              inputMode="numeric"
              selectTextOnFocus
              aria-label={`Counted units of ${line.product.name}`}
              style={styles.qtyInput}
            />
          </View>
          <Text style={[styles.varianceText, varianceStyle]}>{varianceText(variance)}</Text>
          <Pressable
            onPress={onToggleReason}
            style={styles.reasonChip}
            accessibilityRole="button"
            accessibilityLabel={`Reason for ${line.product.name}`}
          >
            <Text style={styles.reasonChipText}>{line.reason ? reasonLabel(line.reason) : 'Reason'}</Text>
          </Pressable>
        </View>
      </View>
      {reasonOpen && (
        <View style={styles.reasonRow}>
          {COUNT_REASONS.map(({ key, label }) => (
            <Pressable
              key={key}
              onPress={() => onReason(key)}
              style={styles.reasonOption}
              accessibilityRole="button"
              accessibilityLabel={`Reason: ${label}`}
            >
              <Text style={styles.reasonOptionText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

// The offer to write this stock-take into Accounting as well as into stock.
//
// `cents === null` renders NOTHING but the sentence beside it, and that is the
// whole design of this control. Shortfall is valued at cost, and any line whose
// product is uncosted contributes zero -- so a count full of uncosted products
// would offer to log a figure far below what actually went missing. A smaller
// number presented as the whole loss is worse than no number, because nothing
// downstream can tell it was partial. So it hides, and says why.
//
// Unticked, for the same reason its restock sibling is: a silent write into a
// shop's books is a surprise, and opt-in is recoverable where opt-out is not.
// The argument is genuinely weaker here -- Restock's default protects against
// double-counting a supplier invoice entered separately, and there is NO
// equivalent risk for shrinkage, because nothing else in the app or in a shop's
// paperwork records it at all. Matched to its sibling deliberately, so the two
// stock sheets do not disagree about how bold they are with somebody's P&L.
function StockLossCheck({
  cents,
  uncostedShortfallLines,
  on,
  onToggle,
}: {
  cents: number | null;
  uncostedShortfallLines: number;
  on: boolean;
  onToggle: () => void;
}) {
  if (cents === null) {
    return (
      <Text style={styles.checkWithheld}>
        {uncostedShortfallLines === 1
          ? '1 of the products that came up short has no cost recorded, so any stock-loss figure here would understate what was lost. Add its cost in Inventory.'
          : `${uncostedShortfallLines} of the products that came up short have no cost recorded, so any stock-loss figure here would understate what was lost. Add their costs in Inventory.`}
      </Text>
    );
  }
  if (cents <= 0) return null;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityLabel="Log the shortfall as stock loss"
      accessibilityState={{ checked: on }}
      style={styles.checkRow}
    >
      <View style={[styles.checkBox, on && styles.checkBoxOn]}>{on && <Text style={styles.checkMark}>✓</Text>}</View>
      <Text style={styles.checkLabel}>Also log {formatCents(cents)} of shortfall as stock loss</Text>
    </Pressable>
  );
}

// The whole sheet route on one screen: get the file, fill it, bring it back,
// read what it says, press the button. Nothing above the footer writes -- the
// plan is planCount's pure reading of the upload, held in state and shown.
function SheetTab({
  fileName,
  plan,
  planSummary,
  busy,
  onDownload,
  onUpload,
  onDownloadRejected,
}: {
  fileName: string | null;
  plan: CountPlan | null;
  planSummary: CountSummary;
  busy: boolean;
  onDownload: () => void;
  onUpload: () => void;
  onDownloadRejected: () => void;
}) {
  const varianceUnitsText = varianceText(planSummary.varianceUnits);
  // `varianceMoneyText`, not `formatCents` directly -- `formatCents` puts an
  // ASCII hyphen inside the currency (`$-13.83`) beside the typographic minus
  // `varianceUnitsText` already uses, which read as a typo in the same pill.
  // See `varianceMoneyText`'s own comment for why the by-hand footer already
  // takes this route.
  const varianceValueText =
    planSummary.varianceCents !== null
      ? varianceMoneyText(planSummary.varianceCents)
      : 'value withheld — some counted products have no cost';

  return (
    <>
      <Text style={[styles.label, styles.labelSpaced]}>THE SHEET YOU GET BACK</Text>
      <Text style={styles.help}>
        Everything each store carries, with what the app says it has. Fill in{' '}
        <Text style={styles.helpStrong}>Counted</Text> — and <Text style={styles.helpStrong}>Reason</Text>, where you
        can.
      </Text>
      <View style={styles.sheetActions}>
        <Pressable onPress={onDownload} disabled={busy} style={styles.ghost}>
          <Text style={styles.ghostText}>Download the sheet</Text>
        </Pressable>
        <Pressable onPress={onUpload} disabled={busy} style={styles.ghost}>
          <Text style={styles.ghostText}>Upload a filled sheet</Text>
        </Pressable>
      </View>
      <Text style={styles.help}>
        Sorted by shelf, not by name. A stock-take is walked, and a sheet in the order of the room is the difference
        between an hour and an afternoon.
      </Text>
      {fileName ? <Text style={styles.fileName}>{fileName}</Text> : null}

      {plan && (
        <>
          {/* Each pill only when it has something to say. A "0 rejected" pill
              is a red-adjacent nothing, and `skipped` gets the plain wording
              it deserves: the sheet is a download of everything the store
              carries, so most of it is MEANT to come back untouched. */}
          <View style={styles.pills}>
            {planSummary.counted > 0 && <Pill tone="ok" text={`${planSummary.counted} counted`} />}
            {planSummary.matched > 0 && <Pill tone="ok" text={`${planSummary.matched} matched`} />}
            {planSummary.differ > 0 && (
              <Pill tone="bad" text={`${planSummary.differ} differ · ${varianceUnitsText} units · ${varianceValueText}`} />
            )}
            {planSummary.reasonlessLines > 0 && (
              <Pill tone="warn" text={`${planSummary.reasonlessLines} with no reason`} />
            )}
            {plan.skipped > 0 && <Pill tone="warn" text={`${plan.skipped} rows left blank — skipped`} />}
            {plan.rejected.length > 0 && <Pill tone="bad" text={`${plan.rejected.length} rejected`} />}
          </View>

          {planSummary.differ > 0 && (
            <>
              <Text style={[styles.label, styles.labelSpaced]}>WHAT WILL CHANGE</Text>
              {plan.counts.map((count) => {
                const differing = count.lines.filter((line) => line.variance !== 0);
                if (differing.length === 0) return null;
                return (
                  <View key={count.locationId} style={styles.receipt}>
                    <View style={styles.receiptCap}>
                      <Text style={styles.receiptName}>{count.locationName}</Text>
                      <Text style={styles.receiptMeta}>
                        {differing.length} line{differing.length === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <View style={styles.changeHeaderRow}>
                      <Text style={[styles.changeHeaderCell, styles.changeCellName]}>Product</Text>
                      <Text style={[styles.changeHeaderCell, styles.changeCellNum]}>App</Text>
                      <Text style={[styles.changeHeaderCell, styles.changeCellNum]}>Counted</Text>
                      <Text style={[styles.changeHeaderCell, styles.changeCellNum]}>Variance</Text>
                      <Text style={[styles.changeHeaderCell, styles.changeCellReason]}>Reason</Text>
                    </View>
                    {differing.map((line) => (
                      <View key={line.productId} style={styles.changeRow}>
                        <Text style={[styles.changeCellName, styles.changeName]} numberOfLines={2}>
                          {line.productName}
                        </Text>
                        <Text style={[styles.changeCellNum, styles.changeValue]}>{line.previousQuantity}</Text>
                        <Text style={[styles.changeCellNum, styles.changeValue]}>{line.countedQuantity}</Text>
                        <Text
                          style={[
                            styles.changeCellNum,
                            styles.changeVariance,
                            line.variance > 0 ? styles.varianceUp : styles.varianceDown,
                          ]}
                        >
                          {varianceText(line.variance)}
                        </Text>
                        <Text
                          style={[styles.changeCellReason, line.reason ? styles.changeReason : styles.lineMetaLow]}
                        >
                          {line.reason ? reasonLabel(line.reason) : '— no reason given'}
                        </Text>
                      </View>
                    ))}
                  </View>
                );
              })}
              <Text style={styles.help}>
                Rows that matched are counted and not listed. Printing every &quot;no change&quot; row would bury the
                ones that need reading.
              </Text>
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

function Pill({ tone, text }: { tone: 'ok' | 'bad' | 'warn'; text: string }) {
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
  lineMetaLow: { color: '#8A5806', fontWeight: '700', fontSize: 12 },
  lineMetaMissing: { fontSize: 12, color: '#A3202F', fontWeight: '700', marginTop: 2, lineHeight: 17 },
  add: { fontSize: 12, fontWeight: '800', color: '#111111' },
  remove: { alignSelf: 'flex-start', marginTop: 6 },
  removeText: { fontSize: 11.5, fontWeight: '700', color: '#9CA3AF' },
  empty: { fontSize: 13, color: '#9CA3AF', marginTop: 12 },

  qtyPair: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
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
  varianceText: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'], minWidth: 30, textAlign: 'right' },
  varianceUp: { color: '#007A38' },
  varianceDown: { color: '#A3202F' },
  reasonChip: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  reasonChipText: { fontSize: 11.5, fontWeight: '700', color: '#111111' },
  reasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 10 },
  reasonOption: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  reasonOptionText: { fontSize: 11.5, fontWeight: '700', color: '#111111' },

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
  receipt: { backgroundColor: '#F6F6F7', borderRadius: 14, padding: 12, marginTop: 8 },
  receiptCap: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 4 },
  receiptName: { fontSize: 13, fontWeight: '800', color: '#111111', flexShrink: 1 },
  receiptMeta: { fontSize: 12, color: '#9CA3AF', fontVariant: ['tabular-nums'] },
  receiptItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 5 },
  receiptItemName: { fontSize: 12.5, color: '#5E5D65', flexShrink: 1 },
  receiptItemQty: { fontSize: 12.5, fontWeight: '800', color: '#111111', fontVariant: ['tabular-nums'] },
  costChange: { fontSize: 12.5, fontWeight: '800', color: '#111111', fontVariant: ['tabular-nums'] },
  costChangeClash: { color: '#8A5806' },
  oversized: { fontSize: 12.5, fontWeight: '700', color: '#8A5806', backgroundColor: '#FDF1DA', borderRadius: 10, padding: 10, marginTop: 8, lineHeight: 18 },
  rejectRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  rejectNumber: { fontSize: 11, fontWeight: '800', color: '#A3202F', letterSpacing: 0.4 },
  rejectReason: { fontSize: 12.5, color: '#5E5D65', marginTop: 2, lineHeight: 18 },

  // WHAT WILL CHANGE's table: Product / App / Counted / Variance / Reason,
  // one row per differing line. Column widths are shared between the header
  // row and the data rows so the two stay lined up.
  changeHeaderRow: { flexDirection: 'row', gap: 6, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#DCDCE4' },
  changeHeaderCell: { fontSize: 10, fontWeight: '800', color: '#9CA3AF', letterSpacing: 0.4 },
  changeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  changeCellName: { flex: 1.5 },
  changeCellNum: { width: 46, textAlign: 'right' },
  changeCellReason: { flex: 1.3 },
  changeName: { fontSize: 12.5, color: '#111111', fontWeight: '700' },
  changeValue: { fontSize: 12.5, color: '#111111', fontVariant: ['tabular-nums'] },
  changeVariance: { fontSize: 12.5, fontWeight: '800', fontVariant: ['tabular-nums'] },
  changeReason: { fontSize: 12, color: '#5E5D65' },

  footerWrap: { marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#DCDCE4', gap: 12 },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  checkBox: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, borderColor: '#DCDCE4', alignItems: 'center', justifyContent: 'center' },
  checkBoxOn: { backgroundColor: '#111111', borderColor: '#111111' },
  checkMark: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', lineHeight: 13 },
  checkLabel: { fontSize: 12.5, fontWeight: '700', color: '#5E5D65', flexShrink: 1 },
  checkWithheld: { fontSize: 12, color: '#9CA3AF', lineHeight: 17 },
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
