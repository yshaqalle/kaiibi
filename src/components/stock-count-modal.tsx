import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';

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
import { listProducts, saveStockCount } from '@/lib/products';
import type { NewExpenseInput, Product, StockCountReason } from '@/types/models';
import {
  COUNT_PAGE_SIZE,
  filterProducts,
  pageSlice,
  plannedLines,
  typedRows,
  walkRow,
  walkRows,
  type CountEntries,
  type CountRow,
} from '@/lib/count-walk';

// A stock-take, by hand or by spreadsheet.
//
// The by-hand tab is ONE LIST. Every product the store carries is already a
// row with a field in it, and typing a number IS counting it -- there is no
// "add to a basket" step, because the catalogue and the basket were the same
// products listed twice.
//
// That makes BLANK the default state of almost every row, and blank has to
// mean something exact: NOBODY COUNTED THIS PRODUCT, and the product is left
// exactly as it was. It is not zero. Zero is a claim -- the shelf is bare --
// and it commits, which is why an untouched field renders a dash and a typed
// zero renders 0. See src/lib/count-walk.ts, which holds that rule.
//
// (An earlier version of this screen PRE-FILLED each field with what the app
// believed, and argued that a row left untouched meant "I looked, it matched".
// That was true when a row only existed because you pressed `Count` on it --
// the act of adding it was the statement. With every product already a row it
// would mean the app had counted every shelf in the shop on its own.)
//
// What has been typed belongs to the PRODUCT, not to the row: `entries` is
// keyed by product id, and Save sends everything typed across every page,
// never what happens to be rendered. A count typed on page 1 and dropped by
// paging to page 2 is invisible until a shelf comes out wrong.
//
// The VARIANCE is a column, not a footnote. The person doing the count does
// not need to be told the 8 they just counted. What they need to see, and what
// they will be asked about, is how far off the app was.
//
// Not built here, deliberately: scanning. The mockup does not propose it, and
// the equivalent work on the restock sheet cost a CRITICAL to get right -- a
// scan landing in a number field while the same product's row was focused read
// the barcode as the quantity. Inventory's own wedge still stands down for the
// whole time this sheet is open (inventory.tsx's `enabled`), so a scan fired
// here does nothing rather than something wrong.

type Tab = 'hand' | 'sheet';

// Below this window width, a row goes two lines -- the name on its own, the
// boxes right-aligned underneath -- rather than staying on one where the
// name has nowhere left to sit. At or above it the row renders exactly as it
// always has: one line, boxes on the right. Every tablet and every ordinary
// web window is well clear of this number, so neither changes.
//
// Worked backward from the same figures `styles` below already uses, not
// chosen as a round one. Starting from the window and spending it, in order:
// the overlay's own 20pt padding a side (styles.overlay), the card's 20pt
// padding a side (styles.card -- its own 560pt cap sits well above where
// this lands, so it is never the binding constraint), the row's own 14pt
// padding a side (styles.countRow), the 12pt gap `lineRow` puts between the
// name and the boxes, and the boxes themselves -- qtyInput (62) +
// varianceBox (58) + reasonChip (108) + clear (28) plus three 8pt gaps
// between them, 280 total (styles.qtyPair's own comment derives the same
// figure). What is left over is what the product name actually gets, and
// the design of record (count-one-step-mockup.html's `.left`) draws that
// name column at a 130px minimum -- below that it reads as cut off, not
// merely snug, and two lines beats one that is losing the fight.
// 130 + 280 + 12 + 14×2 + 20×2 + 20×2 = 530.
const ROW_STACK_BREAKPOINT = 530;

export function StockCountModal({ visible, shopId, onClose, onDone }: {
  visible: boolean;
  shopId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { locations, activeLocation } = useAuth();
  const selectable = useMemo(() => locations.filter((location) => location.active), [locations]);

  // Read once, here, rather than inside every row: it is the same answer for
  // all of them, and `useWindowDimensions` already re-renders this whole
  // component on rotation or a web resize -- see ROW_STACK_BREAKPOINT above
  // for what the number means and where it comes from.
  const { width: windowWidth } = useWindowDimensions();
  const stackedRow = windowWidth < ROW_STACK_BREAKPOINT;

  const [tab, setTab] = useState<Tab>('hand');
  const [chosenLocationId, setLocationId] = useState<string | null>(activeLocation?.id ?? selectable[0]?.id ?? null);
  // Resolved on read rather than repaired in an effect: the initial value is
  // computed once, at first mount, which can be before the session's locations
  // have arrived -- and a one-store shop cannot correct it, because
  // StoreDropdown renders nothing for it.
  const locationId = chosenLocationId ?? activeLocation?.id ?? selectable[0]?.id ?? null;
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  // One-based, and never trusted blind -- `pageSlice` clamps it. Reset by the
  // handlers that change what is being paged (search, category, the store) so
  // page 3 of a set that now has 12 rows is never on screen.
  const [page, setPage] = useState(1);
  const [categories, setCategories] = useState<string[]>([]);
  // Keyed by PRODUCT ID, never by row index and never derived from what is on
  // screen. This is the whole of the paging guarantee: filtering, searching and
  // paging all change which rows render and none of them can touch this.
  const [entries, setEntries] = useState<CountEntries>({});
  // Every write goes through one helper that runs its updater immediately and
  // stores the result in both the ref and the state, so a handler reading what
  // has been typed never reads a render behind.
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  const updateEntries = useCallback((next: (current: CountEntries) => CountEntries) => {
    const value = next(entriesRef.current);
    entriesRef.current = value;
    setEntries(value);
  }, []);
  const [catalogue, setCatalogue] = useState<Product[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the last successful save actually did -- by hand, or (see
  // `commitPlan`) from a sheet whose rejected rows are still on screen. Save
  // no longer closes the sheet (see `submit`), so a successful save and Clear
  // all would otherwise be indistinguishable -- both leave every field blank,
  // on a door that overwrites a shelf with no undo. This is the one thing on
  // screen that tells them apart. Cleared by `setCounted` the moment a new
  // count starts, by `uploadSheet` and `commitPlan` the moment a new sheet
  // attempt starts, so it can never be misread as describing an attempt this
  // one is not, and by `closeAndReset` for the same reason `error` is.
  const [success, setSuccess] = useState<string | null>(null);
  // Which line's reason chips are expanded, by product id. Inline, never a
  // second modal: a sheet opened from a sheet is dropped by iOS without a word
  // and needs useStagedSheet to survive -- five chips that unfold under the row
  // avoid the whole class, and a reason is a five-way choice, not a screen.
  const [reasonOpenFor, setReasonOpenFor] = useState<string | null>(null);
  const [logExpense, setLogExpense] = useState(false);
  // The confirmation, which is a PANEL and never a modal. A modal presented
  // from a modal is silently dropped on iOS and the button reads as dead --
  // this has bitten twice on this branch. It replaces the footer's contents
  // inside the AppModal already on screen, the same way the reason chips
  // unfold under a row.
  const [confirming, setConfirming] = useState(false);

  // Sheet tab
  const [sheetFile, setSheetFile] = useState<string | null>(null);
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([]);
  const [plan, setPlan] = useState<CountPlan | null>(null);
  const [sheetNotice, setSheetNotice] = useState<string | null>(null);
  // Set by a commitPlan that did not reach closeAndReset -- either because a
  // store failed (`failed: true`) or because every store went through but
  // rejected rows are still on screen (`failed: false`; see commitPlan's own
  // tail). Read only by the footer. commitPlan empties plan.counts on EITHER
  // exit so a re-press cannot repeat a store that already went through -- but
  // that same clearing is what let the footer claim "nothing has changed yet"
  // directly under an error naming the store that just changed, and is why
  // `failed` exists: without it, a fully successful commit with rejects left
  // behind would read the same "before the failure above" sentence written
  // for an actual one.
  const [partialCount, setPartialCount] = useState<{ lines: number; stores: number; failed: boolean } | null>(
    null
  );

  // Scoped to the store being counted, because "App says 11" is the number the
  // whole screen is about. Unlike Restock, the shop-wide list is NOT merged in:
  // a stock-take walks a room, and a product this store does not carry has no
  // shelf to walk to. listProducts(shopId, locationId) already draws exactly
  // that line and keeps rows sitting at zero.
  const load = useCallback(async () => {
    if (!locationId) return [] as Product[];
    return listProducts(shopId, locationId);
  }, [shopId, locationId]);

  // A typed count is a claim about a specific shelf -- "App says 11, I found 8"
  // -- and that claim does not carry to a different store just because the two
  // happen to stock a product with the same id. Change the store from one
  // holding 11 to one holding 3 and a surviving "11" would be "found 11 at a
  // shelf nobody walked", ready to overwrite the new store's real count on
  // Save. Losing what was typed is the correct outcome of a store change.
  //
  // `lastLocationRef` is what tells an actual transition apart from this
  // effect's ordinary re-runs (first mount, a product added mid-session
  // triggering a reload) -- both of which must NOT clear a walk someone is
  // mid-typing. It starts equal to the initial `locationId`, so mount never
  // reads as a change, and it is only ever compared against the `locationId`
  // this render closed over, which is exactly the value `load` was rebuilt for.
  // The sheet tab's handover pins it deliberately; see `uploadSheet`.
  //
  // Nothing re-points a product snapshot any more: `entries` holds text and a
  // reason, and every "App says" is read off `catalogue` at render. Replacing
  // `catalogue` IS the re-point.
  const lastLocationRef = useRef(locationId);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const storeChanged = lastLocationRef.current !== locationId;
    lastLocationRef.current = locationId;
    if (storeChanged) {
      updateEntries(() => ({}));
      setReasonOpenFor(null);
      setConfirming(false);
      setPage(1);
    }
    load()
      .then((rows) => {
        if (active) setCatalogue(rows);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [visible, load, updateEntries, locationId]);

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
    updateEntries(() => ({}));
    setNote('');
    setSearch('');
    setCategory(null);
    setPage(1);
    setError(null);
    setSuccess(null);
    setReasonOpenFor(null);
    setLogExpense(false);
    setConfirming(false);
    setPlan(null);
    setSheetFile(null);
    setSheetHeaders([]);
    setSheetNotice(null);
    setPartialCount(null);
    setTab('hand');
    onClose();
  }, [onClose, updateEntries]);

  // Switches the tab AND drops a confirmation left open on the way out. `By
  // hand` -> Save counts -> `By sheet` -> `By hand` must not restore a panel
  // the person walked away from -- `Go back` is the documented exit from a
  // confirmation, and the tab control must not become an undocumented second
  // one. This is also what the sheet-upload handover uses to land back on
  // `hand`: a single-store upload refills `entries` with numbers nobody has
  // reviewed yet, and those must never appear pre-confirmed either.
  const changeTab = useCallback((next: Tab) => {
    setTab(next);
    setConfirming(false);
  }, []);

  // Stores the keystrokes and nothing else. Rewriting text inside onChangeText
  // on a controlled input cannot work: the rewritten string is what the NEXT
  // keystroke is appended to, so a number is reinterpreted before it has
  // finished being typed.
  //
  // An emptied field leaves the ENTRY in place holding a blank string rather
  // than deleting it, so a reason chosen beside it survives a backspace and is
  // there again when the number is retyped. A blank entry is still blank -- see
  // walkRow -- so nothing is sent for it.
  const setCounted = (productId: string, text: string) => {
    // A fresh keystroke means a new count is starting. The success banner
    // (if one is showing) describes a walk that is already over, and leaving
    // it up would let it be read as a claim about the number now being typed.
    setSuccess(null);
    updateEntries((current) => ({
      ...current,
      [productId]: { counted: text, reason: current[productId]?.reason ?? null },
    }));
  };

  // Picking the reason a row already carries clears it, so a mis-tap is
  // undoable without a sixth "None" chip pretending to be a reason. A reason
  // cannot be given to a row nobody has counted: the sheet planner rejects
  // exactly that shape ("Reason is filled in but Counted is empty"), and the
  // two tabs must not disagree about it.
  const setReason = (productId: string, reason: StockCountReason) => {
    updateEntries((current) => {
      const entry = current[productId];
      if (!entry) return current;
      return { ...current, [productId]: { ...entry, reason: entry.reason === reason ? null : reason } };
    });
    setReasonOpenFor(null);
  };

  // Returns ONE row to blank -- the count and the reason together. It does not
  // remove the product, because the product was never added in the first place.
  // The whole entry goes, unlike an emptied field (see `setCounted`), because
  // this is a deliberate "forget this row" rather than a backspace on the way
  // to retyping it.
  const clearRow = (productId: string) => {
    updateEntries((current) => {
      if (!(productId in current)) return current;
      const next = { ...current };
      delete next[productId];
      return next;
    });
    setReasonOpenFor((open) => (open === productId ? null : open));
  };

  // The WHOLE store, walked once. Not `filtered`, and not the page slice: the
  // footer, the Save caption and the commit are about the stock-take, not about
  // what is scrolled into view.
  const rows = useMemo(() => walkRows(catalogue, entries), [catalogue, entries]);
  const typed = useMemo(() => typedRows(rows), [rows]);

  // Starts the walk over. Every field on every page, every reason and the note
  // -- and NOT the store or the tab, which are where the person is standing
  // rather than what they have written down. The stock-loss tick goes too: the
  // shortfall it referred to no longer exists, and a tick with no offer behind
  // it is exactly the stale yes `handExpenseCents` exists to refuse.
  //
  // Placed after `typed` rather than beside `clearRow` above (where the brief
  // that specified this screen put it): `canClearAll` reads `typed`, and
  // `typed` is a `useMemo` declared below `setReason` -- putting this block
  // there instead throws "Cannot access 'typed' before initialization" on
  // every render, since a `const` is in scope but unreadable before its own
  // declaration runs.
  const clearAll = () => {
    updateEntries(() => ({}));
    setNote('');
    setReasonOpenFor(null);
    setLogExpense(false);
    setConfirming(false);
  };
  const canClearAll = !busy && !confirming && (typed.length > 0 || note.trim() !== '');

  const unreadable = useMemo(() => typed.filter((row) => row.state === 'unreadable').length, [typed]);
  const handLines = useMemo(() => plannedLines(rows), [rows]);
  const handSummary = useMemo(() => summariseCount(handLines), [handLines]);

  // Which products are on screen. Separate from `rows` on purpose -- this is
  // the only thing search and the category chips are allowed to change.
  const filtered = useMemo(() => filterProducts(catalogue, search, category), [catalogue, search, category]);

  // One page of `filtered`, plus everything the pager row needs to say about
  // it. `page` is never trusted blind -- `pageSlice` clamps it, since a
  // catalogue can shrink underneath a page number for reasons this component
  // does not drive (a reload after a delete, a narrower store).
  const paged = useMemo(() => pageSlice(filtered, page, COUNT_PAGE_SIZE), [filtered, page]);

  // `plannedLines` is empty both when nothing has been counted and when
  // anything is unreadable, so one non-empty check carries both rules: at least
  // one row reads, and none of them is gibberish.
  const canSubmit = Boolean(locationId) && handLines.length > 0 && !busy;

  // Stock-takes go wrong by being saved against the wrong branch, and the one
  // screen that can catch it is the one right before the write.
  const storeName = useMemo(
    () => selectable.find((location) => location.id === locationId)?.name ?? '',
    [selectable, locationId]
  );

  // The one stock-loss gate, read by the footer's disclosure and by `submit`
  // alike. Written once so the two cannot drift: a panel promising a P&L row
  // that never lands, or hiding one that does, is worse than either behaviour
  // on its own. `shortfallCents` goes null the moment a short line is uncosted,
  // which is why the tick alone is never trusted.
  const handExpenseCents =
    logExpense && handSummary.shortfallCents !== null && handSummary.shortfallCents > 0
      ? handSummary.shortfallCents
      : null;

  // After the count, never before: an expense for a stock-take that failed to
  // land is a number in the P&L with no missing stock behind it. This never
  // throws and never closes anything -- it RETURNS what went wrong so the
  // caller can say so while keeping the count, because the numbers really did
  // change and rolling them back to punish a failed expense loses the more
  // important of the two. (Returning rather than calling setError is what makes
  // that possible: both callers finish by resetting, which would wipe the
  // message.)
  //
  // `countId` is not optional and is not decoration. save_stock_count has
  // already posted the whole write-off as Dr 5100 Inventory Shrinkage / Cr 1200
  // Inventory, and no money moved -- so this row exists for the Expenses screen
  // and the expense reports, and posts NOTHING. The trigger reads
  // expenses.stock_count_id to know that. Without the id it takes the
  // standalone path, 5100 doubles and a till that never opened is credited for
  // stock nobody sold -- with every entry still balancing and the trial balance
  // still zero. Hence a required parameter and not an options bag.
  const logStockLoss = async (
    locId: string,
    amountCents: number,
    countId: string
  ): Promise<string | null> => {
    try {
      await createExpense(shopId, {
        locationId: locId,
        stockCountId: countId,
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

  // The list footer's Save button. It WRITES NOTHING -- it unfolds the
  // confirmation, which carries the only button that commits.
  const askToSave = () => {
    if (!canSubmit) return;
    setError(null);
    // A success banner describes a walk that is already over -- the same
    // reason `setCounted` clears it on the first keystroke of a new one.
    // Opening a fresh confirmation is that same "a new attempt is starting"
    // moment, and it can be reached WITHOUT a keystroke: the sheet-upload
    // handover refills `entries` directly, bypassing `setCounted` entirely,
    // so a stale success from an earlier by-hand save would otherwise still
    // be standing when this confirmation opens.
    setSuccess(null);
    setConfirming(true);
  };

  // Two `onPress`es landing in the same event turn (a double-tap, or two
  // fingers) both read `canSubmit` off the SAME render's closure, since React
  // has not yet re-rendered with `busy: true` when the second one fires -- so
  // the guard at the top of `submit` alone does not stop it. A `ref` closes
  // that gap because it is written synchronously, immediately, and shared by
  // both calls, where `busy` state is not: pre-existing on this door (and on
  // the shipped Restock sibling), but cheap to close on a write with no undo.
  const submittingRef = useRef(false);

  const submit = async () => {
    if (!canSubmit || !locationId) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    // Redundant with `askToSave`'s own clear TODAY -- `onConfirm={submit}` is
    // this function's only caller, and it only renders once `askToSave` has
    // already set `confirming` true, which is the same press that already
    // cleared `success`. Kept anyway: `submit` is the one function that
    // actually SETS `success`, so it is the one place a refused write can
    // never render its error underneath a banner naming a different, earlier
    // walk, even if a future change gives this function a second caller that
    // does not go through `askToSave` first.
    setSuccess(null);
    // ONLY the write is inside the try, and the try ends the moment it
    // resolves. Everything after this point runs against a count that has
    // already committed, so nothing after it may reach a catch that leaves the
    // basket standing. On the restock sheet it did: `await onDone()` sat here,
    // onDone is the Inventory screen's reload, and a reload throwing on a
    // network blip landed in this catch -- an error beside a full basket and a
    // live Save button. Pressing it wrote the same count a second time.
    // The count id is kept, not discarded: it is what tells the expense row
    // below which stock-take it belongs to, and therefore what stops it posting
    // a second Dr 5100 on top of the one save_stock_count just wrote. Declared
    // out here because the try ends the moment the write resolves (see above)
    // and the expense is logged well past it.
    let countId: string;
    try {
      countId = await saveStockCount(
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
      // Back to the list, with everything typed still there -- this is the one
      // failure a shop fixes by pressing again. The panel does NOT stay up: a
      // live "Yes, save" sitting over numbers that just failed is a second
      // route into the same write, which is exactly how the restock branch
      // committed a delivery twice.
      setConfirming(false);
      setBusy(false);
      submittingRef.current = false;
      return;
    }

    // The numbers are IN. What was typed is spent from here on, and it is
    // cleared before anything that can fail.
    updateEntries(() => ({}));
    setNote('');
    setLogExpense(false);
    setConfirming(false);

    // This modal's OWN catalogue, reloaded -- `onDone` below refreshes the
    // screen behind this sheet, which has no way to reach state that lives in
    // here. Without this call every row's "App says" would go on showing the
    // number that was just overwritten until the sheet was closed and
    // reopened, which defeats the entire reason it stays open now. Swallowed
    // like `onDone`, for the same reason: a refresh failing here does not mean
    // the write failed, and the numbers simply stay stale until the next
    // natural reload (a store switch, or a close and reopen).
    const refreshed = await load().catch(() => null);
    if (refreshed) setCatalogue(refreshed);

    // Only after the numbers are in, and only if the offer was actually on
    // screen. `handExpenseCents` is the same expression the footer disclosed,
    // re-read here rather than trusting `logExpense` alone: the tick survives
    // an edit that turns a shortfall into a match, and a checkbox merely
    // disappearing must not leave a stale yes behind it.
    const expenseProblem =
      handExpenseCents !== null ? await logStockLoss(locationId, handExpenseCents, countId) : null;
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
      submittingRef.current = false;
      return;
    }

    // The sheet STAYS OPEN -- a shop with a long catalogue does not finish a
    // stock-take in one sitting, and closing would throw away the store, the
    // search, the category filter and the place in the list, all to be rebuilt
    // by hand before the next shelf. `handLines` is read here rather than
    // recomputed, because it is the exact list that was just sent to
    // `saveStockCount` -- recomputing it now, against the just-reloaded
    // `catalogue`, would compare the new numbers to themselves and find no
    // variance at all. See `styles.footerWrap` for why this renders where it
    // does.
    const changed = handLines.filter((line) => line.variance !== 0).length;
    setSuccess(saveSuccessText(changed, storeName));
    setBusy(false);
    submittingRef.current = false;
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
                  row.location.id === locationId ? entries[row.product.id] : undefined;
                // A blank entry writes BOTH columns empty. A Reason on a row
                // with no Counted is the one shape planCount rejects outright
                // ("Reason is filled in but Counted is empty"), and a sheet
                // this screen produced must not come back rejected.
                if (!chosen || chosen.counted.trim() === '') return '';
                // `counted` is already the raw string the person typed -- see
                // CountEntry. It needs no converting on the way out.
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
    //
    // `success` is deliberately NOT cleared here: uploading only builds a
    // preview, it writes nothing, and a success banner describes the last
    // thing that actually wrote. `commitPlan` and `askToSave` are the two
    // places an attempt to write actually starts, and both already clear it.
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
      updateEntries(() =>
        Object.fromEntries(
          count.lines
            // A line for a product this store does not carry has no shelf to
            // walk to, and `walkRows` would drop it anyway.
            .filter((line) => byId.has(line.productId))
            // The field holds the RAW string a person typed, so a planned
            // number is turned back into text on the way in.
            .map((line) => [line.productId, { counted: String(line.countedQuantity), reason: line.reason }])
        )
      );
      // The handover fills rows scattered through the whole catalogue. A search
      // or a category left over from before would hide every one of them and
      // the notice below would name lines nobody can see.
      setSearch('');
      setCategory(null);
      setPage(1);
      setSheetNotice(
        `${picked.fileName} — ${count.lines.length} line${count.lines.length === 1 ? '' : 's'} ready. Change anything before saving.`
      );
      // changeTab, not setTab: this handover fills `entries` with numbers
      // fresh off the sheet, never reviewed by a person, and a `confirming`
      // left over from an EARLIER by-hand walk must not survive to offer them
      // up pre-confirmed. Redundant with the segment control's OWN
      // `changeTab` today -- reaching this line at all requires having
      // switched to `sheet` through it first, which already cleared
      // `confirming`, and nothing on the sheet tab can set it true again
      // (`askToSave` is the only setter, and its button renders on `hand`
      // only). Kept anyway, for the same reason `submit`'s own `setSuccess
      // (null)` is: a future path to this handover that skips the segment
      // must not reopen this gap.
      changeTab('hand');
    }
  };

  // The plan's own summary, computed by the same function the basket's is --
  // so "2 differ" and a shortfall value mean one thing on both tabs. Declared
  // here, above `commitPlan`, rather than beside `canCommitPlan` below it:
  // `commitPlan` reads it (see `offered`, in the loop below) and a function
  // reading a `useMemo` declared after it in source order is what broke React
  // Compiler's manual-memoization check the first time this was written.
  const planSummary = useMemo(() => summariseCount(plan ? planLines(plan) : []), [plan]);

  // Same reasoning as `submittingRef` above `submit`: two presses in one
  // event turn both read `canCommitPlan` off the same stale render.
  const committingPlanRef = useRef(false);

  // One save_stock_count call per store. A store that fails fails whole and is
  // named; the others still go through, because rolling back good work for a
  // problem the shop can fix by re-uploading one section helps nobody.
  const commitPlan = async () => {
    if (!plan || plan.counts.length === 0) return;
    if (committingPlanRef.current) return;
    committingPlanRef.current = true;
    setBusy(true);
    setError(null);
    // A fresh commit is a fresh attempt: a success banner left over from an
    // earlier commitPlan call (or from the by-hand tab's own `submit`) must
    // not go on describing this one while it is in flight, or sit there
    // unexplained beside an error this attempt is about to raise.
    setSuccess(null);
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
        // This store's own count id, per iteration -- the expense below belongs
        // to THIS stock-take, and pointing it at another store's count would
        // make the trigger skip a row whose own count had not posted.
        const countId = await saveStockCount(
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
            const problem = await logStockLoss(count.locationId, storeShortfall, countId);
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
    const failed = failures.length > 0 || expenseProblems.length > 0;
    setPartialCount(
      succeeded.length > 0
        ? { lines: succeeded.reduce((sum, count) => sum + count.lines.length, 0), stores: succeeded.length, failed }
        : null
    );
    await onDone().catch(() => {});
    setBusy(false);
    committingPlanRef.current = false;
    if (failed) {
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
    // Every store went through. `plan.rejected` is untouched by the loop above
    // -- it is planCount's own reading of the upload, not something commitPlan
    // produces -- so a sheet that carried both good rows and bad ones still has
    // its bad ones sitting right here, with the modal about to take the only
    // way to see them or download them along with it. CsvImportModal's own
    // import report stays open for exactly this reason (see its `step ===
    // 'done'` branch): closing is the right move only once there is nothing
    // left on screen to show.
    if (plan.rejected.length > 0) {
      setSuccess(sheetCommitSuccessText(succeeded, plan.rejected.length));
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
            <View style={styles.headerButtons}>
              {tab === 'hand' && (
                <Pressable
                  onPress={clearAll}
                  disabled={!canClearAll}
                  style={[styles.clearAll, !canClearAll && styles.clearAllOff]}
                  accessibilityRole="button"
                  accessibilityLabel="Clear all"
                >
                  <Text style={[styles.clearAllText, !canClearAll && styles.clearAllTextOff]}>Clear all</Text>
                </Pressable>
              )}
              <Pressable onPress={closeAndReset} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.segment}>
            {(['hand', 'sheet'] as const).map((option) => (
              <Pressable
                key={option}
                onPress={() => changeTab(option)}
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

                {/* Deliberately not ScanSafeField -- no scan path is offered here,
                    and wrapping a field in a scan guard that can never fire is a
                    component pretending to do something. */}
                <TextInput
                  value={search}
                  onChangeText={(text) => {
                    setSearch(text);
                    setPage(1);
                  }}
                  placeholder="Search by name, SKU or barcode…"
                  placeholderTextColor="#999999"
                  aria-label="Search products"
                  style={[styles.input, styles.inputSpaced]}
                />
                {categories.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.chipScroll}
                    contentContainerStyle={styles.chips}
                  >
                    <CategoryChip
                      label="All"
                      active={category === null}
                      onPress={() => {
                        setCategory(null);
                        setPage(1);
                      }}
                    />
                    {categories.map((item) => (
                      <CategoryChip
                        key={item}
                        label={item}
                        active={category === item}
                        onPress={() => {
                          setCategory(item);
                          setPage(1);
                        }}
                      />
                    ))}
                  </ScrollView>
                )}

                {filtered.length === 0 ? (
                  <Text style={styles.empty}>
                    {search.trim() || category !== null
                      ? 'Nothing here matches that.'
                      : 'This store carries nothing to count yet.'}
                  </Text>
                ) : (
                  <View style={styles.listWrap}>
                    {/* One COUNTED / OFF BY / WHY header for the whole list, not
                        one per row. Widths (62 / 58 / 108 / 28) and the 8px gap
                        mirror qtyPair's own field / varianceBox / reasonChip /
                        clear exactly, so the labels sit directly over their
                        columns: 62+58+108+28 + 3×8 = 280 on both sides. The
                        trailing `capClear` carries no label -- the mockup draws
                        that header cell empty too (count-one-step-mockup.html's
                        `overClear`), since a lone × has nothing to caption.

                        ABSENT when the row itself has stacked (`stackedRow`),
                        rather than left floating: this header only names a
                        column when the boxes ARE one, sitting in a straight
                        line at the right of every row. Stacked, the boxes are
                        each row's own second line, directly under THAT row's
                        name -- there is no shared column left for a caption
                        placed once, above all of them, to describe, and it
                        would read as labelling the first product's name
                        instead. Each box still says what it is on its own
                        (a dash, a signed number in its tint, the word
                        "Reason"), which is what a header exists to shortcut. */}
                    {!stackedRow && (
                      <View style={styles.columnHeaderRow}>
                        <View style={styles.columnHeaderSpacer} />
                        <View style={styles.columnHeaderCaps}>
                          <Text style={[styles.cap, styles.capField]}>COUNTED</Text>
                          <Text style={[styles.cap, styles.capVariance]}>OFF BY</Text>
                          <Text style={[styles.cap, styles.capChip]}>WHY</Text>
                          <View style={styles.capClear} />
                        </View>
                      </View>
                    )}
                    <View style={styles.listRows}>
                      {paged.items.map((item) => (
                        <CountRowView
                          key={item.id}
                          row={walkRow(item, entries)}
                          stacked={stackedRow}
                          reasonOpen={reasonOpenFor === item.id}
                          onToggleReason={() =>
                            setReasonOpenFor((current) => (current === item.id ? null : item.id))
                          }
                          onCounted={(text) => setCounted(item.id, text)}
                          onReason={(reason) => setReason(item.id, reason)}
                          onClear={() => clearRow(item.id)}
                        />
                      ))}
                    </View>
                    {/* ABSENT below the threshold, not greyed: a control that
                        can never do anything should not be on screen, and most
                        shops on the platform carry fewer than a hundred
                        products. */}
                    {filtered.length > COUNT_PAGE_SIZE && (
                      <View style={styles.pager}>
                        <Text style={styles.pagerInfo}>
                          {`Showing ${paged.from}–${paged.to} of ${filtered.length}${
                            typed.length > 0 ? ` · ${typed.length} counted so far, on any page` : ''
                          }`}
                        </Text>
                        <View style={styles.pagerButtons}>
                          <Pressable
                            onPress={() => setPage(paged.page - 1)}
                            disabled={paged.page <= 1}
                            style={[styles.pageButton, paged.page <= 1 && styles.pageButtonOff]}
                            accessibilityRole="button"
                            accessibilityLabel="Previous page"
                          >
                            <Text style={[styles.pageButtonText, paged.page <= 1 && styles.pageButtonTextOff]}>
                              Previous
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => setPage(paged.page + 1)}
                            disabled={paged.page >= paged.pageCount}
                            style={[styles.pageButton, paged.page >= paged.pageCount && styles.pageButtonOff]}
                            accessibilityRole="button"
                            accessibilityLabel="Next page"
                          >
                            <Text
                              style={[
                                styles.pageButtonText,
                                paged.page >= paged.pageCount && styles.pageButtonTextOff,
                              ]}
                            >
                              Next
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    )}
                  </View>
                )}

                <Text style={[styles.label, styles.labelSpaced]}>NOTE</Text>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Anything worth recording about this stock-take"
                  placeholderTextColor="#999999"
                  aria-label="Note about this stock-take"
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

          </ScrollView>

          <View style={styles.footerWrap}>
            {/* In the footer, NOT at the foot of the ScrollView above it. A
                failed write is reported here, and the ScrollView is where the
                catalogue lives -- on a shop with 119 products the message
                landed below all of them, off screen, so a save that refused
                looked like a save that did nothing. The button that failed and
                the reason it failed belong to each other.

                A SUCCESSFUL write is reported in the same place for the same
                reason. Save no longer closes the sheet (see `submit`), so a
                banner scrolled to the foot of a long catalogue would be just
                as unreachable as the error above always was -- and a
                successful save nobody can see is indistinguishable from
                Clear all, on a door that overwrites stock with no undo. */}
            {error && <Text style={styles.error}>{error}</Text>}
            {success && <Text style={styles.success}>{success}</Text>}
            {tab === 'hand' && confirming ? (
              <CountConfirm
                storeName={storeName}
                lines={handLines}
                summary={handSummary}
                untouched={catalogue.length - handSummary.counted}
                expenseCents={handExpenseCents}
                typedCount={typed.length}
                unreadable={unreadable}
                busy={busy}
                onBack={() => setConfirming(false)}
                onConfirm={submit}
              />
            ) : (
              <>
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
                    {/* Hidden while anything is unreadable: `handLines` is `[]` then
                        (see plannedLines) and every figure here would read as zero
                        sitting directly under a live per-row variance -- a
                        contradiction, not an honest partial total. Nothing typed at
                        all is still allowed through as zeroes, which is the honest
                        reading of a walk not started. */}
                    {handLines.length > 0 && (
                      <View style={styles.basket}>
                        <View style={styles.basketCap}>
                          <Text style={styles.basketCapLabel}>VARIANCE</Text>
                          <Text style={styles.basketCapTotal}>
                            {`${varianceText(handSummary.varianceUnits)} · ${varianceMoneyText(handSummary.varianceCents)}`}
                          </Text>
                        </View>
                        <Text style={styles.lineMeta}>
                          {`${handSummary.counted} counted · ${handSummary.matched} matched · ${handSummary.differ} differ · ${catalogue.length - handSummary.counted} left alone. Nothing changes until you press Save.`}
                        </Text>
                      </View>
                    )}
                    <View style={styles.footerRow}>
                      <View style={styles.footerTotal}>
                        <Text style={styles.footerTotalText}>
                          {`Save ${typed.length} count${typed.length === 1 ? '' : 's'}`}
                        </Text>
                        <Text style={styles.footerTotalHint}>{countHint(typed.length, unreadable, handSummary)}</Text>
                      </View>
                      <Pressable
                        onPress={askToSave}
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
                          ? partialCount.failed
                            ? `to ${partialCount.stores} store${partialCount.stores === 1 ? '' : 's'} before the failure above`
                            : `to ${partialCount.stores} store${partialCount.stores === 1 ? '' : 's'} · nothing left to save`
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
              </>
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
// explained. Ordered by what the person has to do next. A BLANK row is never
// mentioned, because a blank row is not a problem -- it is a product nobody
// counted, and on a 240-product catalogue that is almost all of them.
function countHint(typedCount: number, unreadable: number, summary: CountSummary): string {
  if (typedCount === 0) return 'Nothing counted yet';
  if (unreadable > 0) {
    return unreadable === 1
      ? 'One line is not a whole number — just the digits'
      : `${unreadable} lines are not whole numbers — just the digits`;
  }
  return `${summary.differ} will change a number`;
}

// The footer's success banner, once a save has landed -- echoes CountConfirm's
// own headline (below), past tense: a row counted at the figure it already
// held was not a change there, and it is not one here either. `changed` is
// `handLines` filtered on `variance !== 0`, the same rule `CountConfirm` uses
// for its own `changing`, so the two never disagree about what "changed"
// means on this screen.
function saveSuccessText(changed: number, storeName: string): string {
  return changed === 0
    ? `Nothing changed at ${storeName} — every count matched`
    : `${changed} product${changed === 1 ? '' : 's'} changed at ${storeName}`;
}

// commitPlan's own success line -- read only once every store in the plan has
// gone through and the only thing left on the sheet tab is rows planCount
// already refused. Kept separate from `saveSuccessText` above rather than
// generalised to cover both: that one names ONE store, because the by-hand
// basket is always exactly one store's walk, and a plan is routinely several.
function sheetCommitSuccessText(succeeded: PlannedCount[], rejectedRowCount: number): string {
  const lines = succeeded.reduce((sum, count) => sum + count.lines.length, 0);
  const stores = succeeded.length;
  return `${lines} counted across ${stores} store${stores === 1 ? '' : 's'}. ${rejectedRowCount} row${
    rejectedRowCount === 1 ? '' : 's'
  } rejected.`;
}

function CountRowView({
  row,
  stacked,
  reasonOpen,
  onToggleReason,
  onCounted,
  onReason,
  onClear,
}: {
  row: CountRow;
  // Phone width, from `StockCountModal`'s own ROW_STACK_BREAKPOINT check --
  // read once up there rather than per row, since it is the same answer for
  // all of them.
  stacked: boolean;
  reasonOpen: boolean;
  onToggleReason: () => void;
  onCounted: (text: string) => void;
  onReason: (reason: StockCountReason) => void;
  onClear: () => void;
}) {
  const touched = row.state !== 'blank';
  // One of three tints, never colour alone: the sign inside `varianceText`
  // (−2 / +3 / 0) survives for a deutan viewer even where red and green do
  // not, so the box's background and the box's own text colour always agree on
  // the same direction rather than one of them carrying it alone.
  const direction = row.variance === null || row.variance === 0 ? 'flat' : row.variance > 0 ? 'up' : 'down';
  const varianceBoxStyle = !touched
    ? styles.varianceBoxNone
    : direction === 'up'
      ? styles.varianceBoxUp
      : direction === 'down'
        ? styles.varianceBoxDown
        : styles.varianceBoxFlat;
  const varianceColorStyle = !touched
    ? styles.varianceNone
    : direction === 'up'
      ? styles.varianceUp
      : direction === 'down'
        ? styles.varianceDown
        : styles.varianceFlat;
  return (
    <View style={[styles.countRow, touched && styles.countRowCounted]}>
      <View style={[styles.lineRow, stacked && styles.lineRowStacked]}>
        <View style={styles.lineText}>
          {/* Capped everywhere, not only once stacked: line 1 has the full
              row width here, but a name long enough to wrap three or four
              lines would still bloat the row and break the list's rhythm.
              Two lines, matching this same file's `changeName` on the sheet
              tab's own change table -- ellipsized, never silently cut off
              mid-word, by RN's own default `ellipsizeMode`. */}
          <Text style={styles.lineName} numberOfLines={2}>{row.product.name}</Text>
          <Text style={styles.lineMeta}>{`App says ${row.product.stock}`}</Text>
        </View>
        <View style={[styles.qtyPair, stacked && styles.qtyPairStacked]}>
          {/* `placeholder`, never a value: the field's `value` stays '' for an
              uncounted row, so blank and a typed 0 can never be confused by
              anything reading this component -- including the commit. */}
          <TextInput
            value={row.typed}
            onChangeText={onCounted}
            keyboardType="number-pad"
            inputMode="numeric"
            selectTextOnFocus
            placeholder="—"
            placeholderTextColor="#B6B6BC"
            aria-label={`Counted units of ${row.product.name}`}
            style={[styles.qtyInput, !touched && styles.qtyInputBlank]}
          />
          <View style={[styles.varianceBox, varianceBoxStyle]}>
            <Text style={[styles.varianceText, varianceColorStyle]}>
              {touched ? varianceText(row.variance) : '·'}
            </Text>
          </View>
          {touched ? (
            <Pressable
              onPress={onToggleReason}
              style={styles.reasonChip}
              accessibilityRole="button"
              accessibilityLabel={`Reason for ${row.product.name}`}
            >
              <Text style={styles.reasonChipText}>{row.reason ? reasonLabel(row.reason) : 'Reason'}</Text>
            </Pressable>
          ) : (
            // Inert on purpose -- a reason is a statement about a count, and an
            // untouched row has not made one. Pressable here reads as a control
            // that folds up and records something; it would record nothing, and
            // the fold-up alone reads as confirmation. Matches the mockup, which
            // draws this cell as a dash precisely so there is nothing to press.
            <View style={styles.reasonChipBlank}>
              <Text style={styles.reasonChipBlankText}>—</Text>
            </View>
          )}
          {touched ? (
            // The × that replaces `Remove`: there is no basket to take a line
            // out of, so this returns the row to blank rather than deleting a
            // product that was never added in the first place. Only on a
            // counted row -- see clearRow's own comment for why blank has
            // nothing to clear.
            <Pressable
              onPress={onClear}
              style={styles.clear}
              accessibilityRole="button"
              accessibilityLabel={`Clear ${row.product.name}`}
            >
              <Text style={styles.clearText}>×</Text>
            </Pressable>
          ) : (
            // An empty spacer, not nothing -- it holds the column's width so
            // an uncounted row's boxes stay under the same header caps as a
            // counted row's, exactly the way varianceBoxNone and
            // reasonChipBlank already hold theirs.
            <View style={styles.clearSlot} />
          )}
        </View>
      </View>
      {touched && reasonOpen && (
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

// Save asks first, and shows its working.
//
// A PANEL, deliberately, not a sheet: a modal presented from a modal is
// silently dropped on iOS and the button just reads as dead. This replaces the
// footer inside the AppModal already on screen, the same way the reason chips
// unfold under a row.
//
// The headline is the number that CHANGES, not the number counted. A row
// counted at the figure it already held changes nothing, and saying otherwise
// overstates what is about to happen on the one screen that exists to state it
// exactly.
function CountConfirm({
  storeName,
  lines,
  summary,
  untouched,
  expenseCents,
  typedCount,
  unreadable,
  busy,
  onBack,
  onConfirm,
}: {
  storeName: string;
  lines: PlannedCountLine[];
  summary: CountSummary;
  untouched: number;
  expenseCents: number | null;
  // Neither is derivable from `lines` -- an unreadable row never reaches it
  // (plannedLines returns `[]` for the WHOLE walk the moment any row is
  // unreadable) and a blank one was never in it. Both exist so this panel can
  // say WHY it has nothing to commit, rather than going quiet the way the
  // footer's own hint would if this panel simply covered it up.
  typedCount: number;
  unreadable: number;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const changing = lines.filter((line) => line.variance !== 0);
  const matched = lines.filter((line) => line.variance === 0);
  // `lines` IS `handLines` -- empty both when nothing has been counted and
  // when ANY row (not necessarily one shown here) is unreadable. Either way
  // there is nothing for `onConfirm` to commit: `submit` itself already
  // refuses on `!canSubmit`, which this panel's button must now agree with,
  // never merely on `busy`. Without this a person can clear the one row this
  // panel was about (the × is still live behind it) or make some OTHER row
  // unreadable while it is open, and face a button reading "Yes, record the
  // count" that is byte-identical to the one that does commit, silently
  // pressing nothing.
  const nothingPlanned = lines.length === 0;
  return (
    <View style={styles.confirm}>
      <Text style={styles.confirmTitle}>
        {nothingPlanned
          ? 'Nothing to confirm'
          : changing.length === 0
            ? 'Nothing will change'
            : `${changing.length} product${changing.length === 1 ? '' : 's'} will change`}
      </Text>
      <Text style={styles.confirmWhere}>
        {nothingPlanned
          ? // The footer's own hint, reused rather than covered up: it already
            // says correctly why nothing is plannable -- nothing typed at all,
            // or which line(s) do not read -- and this is now the only place
            // on screen that sentence can be read while the panel is up.
            countHint(typedCount, unreadable, summary)
          : `At ${storeName} · ${summary.counted} counted${
              matched.length > 0 ? `, ${matched.length} already matched` : ''
            }`}
      </Text>

      {/* Scrolls rather than truncates. The whole point of a confirmation is
          auditing it, and "40 products will change" has to be a list a person
          can actually read rather than a number they have to trust. */}
      {changing.length > 0 && (
        <ScrollView style={styles.confirmList} contentContainerStyle={styles.confirmListInner}>
          {changing.map((line) => (
            <View key={line.productId} style={styles.confirmRow}>
              <View style={styles.confirmRowText}>
                <Text style={styles.confirmName}>{line.productName}</Text>
                {/* Including "no reason given", because unexplained shrinkage
                    is the finding, and a blank here would read as none. */}
                <Text style={styles.confirmReason}>
                  {line.reason ? reasonLabel(line.reason) : 'no reason given'}
                </Text>
              </View>
              <Text style={styles.confirmArrow}>
                <Text style={styles.confirmFrom}>{line.previousQuantity}</Text>
                <Text style={styles.confirmFrom}> → </Text>
                <Text style={line.variance > 0 ? styles.varianceUp : styles.varianceDown}>
                  {line.countedQuantity}
                </Text>
              </Text>
            </View>
          ))}
        </ScrollView>
      )}

      {matched.length > 0 && (
        <Text style={styles.confirmQuiet}>
          {matched.length === 1
            ? `${matched[0].productName} was counted at ${matched[0].countedQuantity} and is already ${matched[0].countedQuantity} — it will be recorded, but no number moves.`
            : `${matched.length} products were counted at the figure they already held — they will be recorded, but no numbers move.`}
        </Text>
      )}
      {untouched > 0 && (
        <Text style={styles.confirmQuiet}>
          {untouched === 1
            ? '1 product was not counted and is untouched.'
            : `${untouched} products were not counted and are untouched.`}
        </Text>
      )}
      {expenseCents !== null && (
        <Text style={styles.confirmMoney}>
          {`Also logs ${formatCents(expenseCents)} as a stock-loss expense`}
        </Text>
      )}

      <View style={styles.confirmButtons}>
        {/* "Go back", not "Cancel": Cancel reads like it might throw the walk
            away, and on a shelf somebody just spent twenty minutes counting
            that ambiguity is cruel. */}
        <Pressable
          onPress={onBack}
          disabled={busy}
          style={styles.confirmBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.ghostText}>Go back</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={busy || nothingPlanned}
          style={[styles.primary, (busy || nothingPlanned) && styles.disabled]}
          accessibilityRole="button"
          accessibilityLabel="Confirm and save the count"
        >
          <Text style={styles.primaryText}>
            {busy
              ? 'Saving…'
              : changing.length === 0
                ? 'Yes, record the count'
                : `Yes, save ${changing.length} change${changing.length === 1 ? '' : 's'}`}
          </Text>
        </Pressable>
      </View>
    </View>
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
  headerButtons: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Disabled rather than absent when there is nothing to clear (`canClearAll`)
  // -- unlike Clear all's own absence over the sheet tab, this is the same
  // control staying in place with nothing to do yet, not a control that does
  // not apply here at all.
  clearAll: { borderWidth: 1, borderColor: '#DCDCE4', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11 },
  clearAllOff: { borderColor: '#F2F2F2' },
  clearAllText: { fontSize: 12.5, fontWeight: '700', color: '#5E5D65' },
  clearAllTextOff: { color: '#B6B6BC' },
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
  inputSpaced: { marginTop: 16 },
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

  lineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 10 },
  // Phone width (see ROW_STACK_BREAKPOINT): the name becomes line 1 at full
  // width via the column default of `alignItems: 'stretch'`, and `gap: 12`
  // -- inherited unchanged from `lineRow` above -- becomes the vertical space
  // between it and line 2, rather than the horizontal space between name and
  // boxes. `qtyPairStacked` below is what actually pulls the boxes to the
  // right on that second line; this alone would leave them at the left.
  lineRowStacked: { flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start' },
  lineText: { flex: 1 },
  lineName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  lineMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  lineMetaLow: { color: '#8A5806', fontWeight: '700', fontSize: 12 },
  lineMetaMissing: { fontSize: 12, color: '#A3202F', fontWeight: '700', marginTop: 2, lineHeight: 17 },
  empty: { fontSize: 13, color: '#9CA3AF', marginTop: 12 },

  // The by-hand list: one row per product (`countRow`), 8px of air between
  // them (`listRows`'s own gap), and one column header (`columnHeaderRow`)
  // above the whole stack instead of a `cap` repeated on every row.
  listWrap: { marginTop: 16 },
  columnHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingBottom: 8 },
  columnHeaderSpacer: { flex: 1 },
  columnHeaderCaps: { flexDirection: 'row', gap: 8 },
  capField: { width: 62, textAlign: 'center' },
  capVariance: { width: 58, textAlign: 'center' },
  capChip: { width: 108, textAlign: 'center' },
  capClear: { width: 28 },
  listRows: { gap: 8 },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#F2F2F2' },
  pagerInfo: { fontSize: 12, color: '#9CA3AF', flexShrink: 1 },
  pagerButtons: { flexDirection: 'row', gap: 6 },
  pageButton: { borderWidth: 1, borderColor: '#DCDCE4', borderRadius: 999, paddingHorizontal: 13, paddingVertical: 6 },
  pageButtonOff: { borderColor: '#F2F2F2' },
  pageButtonText: { fontSize: 12, fontWeight: '700', color: '#5E5D65' },
  pageButtonTextOff: { color: '#B6B6BC' },
  // Untinted until something is typed into it. The tint IS the signal that a
  // row has been counted, on a list where almost every row has not been.
  countRow: { borderRadius: 14, paddingHorizontal: 14 },
  countRowCounted: { backgroundColor: '#F7F7F7' },

  qtyPair: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  // Sized to its own content (280pt, see ROW_STACK_BREAKPOINT) and pinned to
  // the right edge of the now-vertical `lineRowStacked`, instead of
  // stretching to the full row width the way `lineText` (the name) does --
  // this is what makes line 2 read as "boxes, right-aligned" and not "boxes,
  // left-aligned under a name that no longer touches them".
  qtyPairStacked: { alignSelf: 'flex-end' },
  cap: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6, color: '#9CA3AF' },
  qtyInput: {
    // White, not the field's old grey -- the row underneath it is grey now
    // once counted (`countRowCounted`), and the field has to stay the one
    // thing on the row that still reads as typeable.
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    height: 38,
    width: 62,
    paddingHorizontal: 10,
    color: '#111111',
    fontWeight: '700',
    textAlign: 'right',
  },
  qtyInputBlank: { backgroundColor: '#F2F2F2' },
  costInput: { width: 78 },
  varianceText: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  // Sign and tint together, never the tint alone -- '−2' / '+3' / '0' read the
  // same to a deutan viewer whether or not the colour behind them survives a
  // refactor.
  varianceBox: { width: 58, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  varianceBoxUp: { backgroundColor: '#E9F5EE' },
  varianceBoxDown: { backgroundColor: '#FBEDEE' },
  varianceBoxFlat: { backgroundColor: '#FFFFFF' },
  varianceBoxNone: { backgroundColor: 'transparent' },
  varianceUp: { color: '#007A38' },
  varianceDown: { color: '#A3202F' },
  varianceFlat: { color: '#9CA3AF' },
  varianceNone: { color: '#B6B6BC' },
  reasonChip: {
    // White for the same reason the field is: the card behind it is grey now,
    // and a grey pill on a grey card has no edge left to read as a button.
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    width: 108,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reasonChipText: { fontSize: 11.5, fontWeight: '700', color: '#111111' },
  // Untouched row: no fill at all, not white -- there is no pressable surface
  // to suggest, only the dash matching varianceBoxNone's own '·'.
  reasonChipBlank: { width: 108, height: 38, alignItems: 'center', justifyContent: 'center' },
  reasonChipBlankText: { fontSize: 12, fontWeight: '600', color: '#B6B6BC' },
  reasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 10 },
  reasonOption: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  reasonOptionText: { fontSize: 11.5, fontWeight: '700', color: '#111111' },
  // The × that replaces Remove on a counted row, and the spacer that holds its
  // column open on a blank one -- same width (28), so `qtyPair`'s total stays
  // constant whether or not the row has anything to clear.
  clear: { width: 28, height: 28, borderRadius: 999, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  clearSlot: { width: 28, height: 28 },
  clearText: { fontSize: 14, fontWeight: '700', color: '#6B6B73' },

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
  // Same shape as `error`, in the green this file already uses for a positive
  // reading (`varianceUp`, `pillText_ok`) -- mutually exclusive with it in
  // practice, since `submit` only ever sets one or the other for a given save.
  success: { color: '#007A38', fontSize: 13, fontWeight: '700', marginTop: 12 },

  // The confirmation panel that replaces the footer -- see CountConfirm.
  confirm: { backgroundColor: '#F6F6F7', borderRadius: 16, padding: 14 },
  confirmTitle: { fontSize: 15, fontWeight: '800', color: '#111111' },
  confirmWhere: { fontSize: 12.5, color: '#9CA3AF', marginTop: 2, marginBottom: 10 },
  confirmList: { maxHeight: 180 },
  confirmListInner: { backgroundColor: '#FFFFFF', borderRadius: 12, paddingHorizontal: 12 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  confirmRowText: { flexShrink: 1 },
  confirmName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  confirmReason: { fontSize: 12, fontWeight: '600', color: '#9CA3AF', marginTop: 1 },
  confirmArrow: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  confirmFrom: { color: '#9CA3AF', fontWeight: '600' },
  confirmQuiet: { fontSize: 12.5, color: '#9CA3AF', marginTop: 10, lineHeight: 18 },
  confirmMoney: { fontSize: 12.5, fontWeight: '700', color: '#8A5806', backgroundColor: '#FDF1DA', borderRadius: 10, padding: 10, marginTop: 10 },
  confirmButtons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  confirmBack: { borderWidth: 1, borderColor: '#DCDCE4', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12 },
});
