import type { PlannedCountLine } from '@/lib/count-import';
import { isUncosted } from '@/lib/product-costing';
import { readCountedQuantity } from '@/lib/restock-typed-input';
import type { Product, StockCountReason } from '@/types/models';

// What a by-hand stock-take amounts to, with nothing rendered.
//
// The one rule this file exists to hold: WHAT HAS BEEN TYPED BELONGS TO THE
// PRODUCT, NOT TO THE ROW. `CountEntries` is keyed by product id, and every
// function here takes the catalogue it should walk as an argument. Nothing in
// this file knows what is on screen, which is the point -- a count typed on
// page 1 and dropped by paging to page 2 is invisible until a shelf comes out
// wrong, and state tied to what is rendered is exactly how that happens.
//
// The three states a field can be in are the whole design of the by-hand tab:
//
//   blank      -- nobody counted this product. It is skipped and the product is
//                 left exactly as it was. This is the DEFAULT, and it is why an
//                 untouched field renders a dash rather than a number.
//   counted    -- a whole number, INCLUDING ZERO. Zero is a claim (the shelf is
//                 bare) and it commits.
//   unreadable -- something is in the field and it is not a count. `abc` is a
//                 mistake, not a decision, so it blocks the commit rather than
//                 being quietly skipped the way a blank is.

export type CountEntry = {
  // The RAW string the person typed, never a parsed number and never rewritten
  // on the way in. See restock-typed-input.ts for why that is the whole design
  // of this screen's input handling.
  counted: string;
  reason: StockCountReason | null;
};

export type CountEntries = Record<string, CountEntry>;

export type CountRowState = 'blank' | 'counted' | 'unreadable';

export type CountRow = {
  product: Product;
  typed: string;
  reason: StockCountReason | null;
  state: CountRowState;
  // The reading, or null when there is none -- blank and unreadable alike.
  counted: number | null;
  variance: number | null;
};

// A hundred rows, each carrying a TextInput, is what a phone renders without
// complaint. It is also the threshold below which the pager is absent entirely:
// most shops on the platform carry fewer than a hundred products, so for most
// of them there is no pager and nothing new to learn.
export const COUNT_PAGE_SIZE = 100;

export function walkRow(product: Product, entries: CountEntries): CountRow {
  const entry = entries[product.id];
  const typed = entry?.counted ?? '';
  const reason = entry?.reason ?? null;
  if (typed.trim() === '') {
    return { product, typed, reason, state: 'blank', counted: null, variance: null };
  }
  const counted = readCountedQuantity(typed);
  if (counted === null) {
    return { product, typed, reason, state: 'unreadable', counted: null, variance: null };
  }
  return { product, typed, reason, state: 'counted', counted, variance: counted - product.stock };
}

export function walkRows(catalogue: Product[], entries: CountEntries): CountRow[] {
  return catalogue.map((product) => walkRow(product, entries));
}

// Rows the person has touched, whether or not what they typed reads. Used for
// the "N counted so far, on any page" figure and for the Save caption -- both
// of which are about the walk, not about what will commit.
export function typedRows(rows: CountRow[]): CountRow[] {
  return rows.filter((row) => row.state !== 'blank');
}

// The plan this walk amounts to, in exactly the shape the sheet tab builds --
// so one summariseCount serves both tabs and the two can never disagree about
// what "2 differ" or "$13.83 of shortfall" means.
//
// EMPTY while any row is unreadable, deliberately. A summary computed over the
// readable half of a walk is a smaller number presented as the whole thing,
// sitting directly under a live per-row variance -- a contradiction, not an
// honest partial total. The caller gates Save on this being non-empty, so the
// same rule blocks the commit and empties the footer.
export function plannedLines(rows: CountRow[]): PlannedCountLine[] {
  if (rows.some((row) => row.state === 'unreadable')) return [];
  return rows
    .filter((row) => row.state === 'counted')
    .map((row) => ({
      productId: row.product.id,
      productName: row.product.name,
      previousQuantity: row.product.stock,
      countedQuantity: row.counted!,
      variance: row.variance!,
      reason: row.reason,
      // Null, never zero: zero is a real answer (a free sample), which is the
      // distinction isUncosted exists to keep.
      unitCostCents: isUncosted(row.product) ? null : row.product.costCents,
    }));
}

// Name, SKU or barcode, and the category chips. Deliberately UNCAPPED: the
// two-step picker sliced to 12 because it was a search-results list you added
// from, and one list of everything is the opposite -- a cap here is a silent
// refusal to show a shelf someone is standing in front of.
export function filterProducts(catalogue: Product[], search: string, category: string | null): Product[] {
  const query = search.trim().toLowerCase();
  return catalogue.filter(
    (product) =>
      (category === null || product.category === category) &&
      (!query ||
        product.name.toLowerCase().includes(query) ||
        (product.sku ?? '').toLowerCase().includes(query) ||
        (product.barcode ?? '').toLowerCase().includes(query))
  );
}

// One page of an already-filtered list, plus everything the pager row has to
// say about it.
//
// The page number is CLAMPED rather than trusted. The caller resets to page 1
// whenever the filter changes, but a catalogue can also shrink underneath a
// page number for reasons the caller does not drive -- a reload after a product
// is deleted, a store with fewer products. An unclamped slice renders an empty
// list with a pager insisting there are 240 products, and there is nothing on
// screen to say which is lying.
export function pageSlice<T>(
  items: T[],
  page: number,
  size: number
): { page: number; pageCount: number; items: T[]; from: number; to: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const clamped = Math.min(Math.max(1, Math.trunc(page)), pageCount);
  const start = (clamped - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    page: clamped,
    pageCount,
    items: slice,
    from: slice.length === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}
