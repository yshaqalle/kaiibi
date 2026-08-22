import { normalizeBarcode } from '@/lib/barcode';
import type { CsvColumn, ParsedCsv } from '@/lib/csv';
import type { RejectedRow, TemplateColumn } from '@/lib/import-shared';
import { isUncosted } from '@/lib/product-costing';
import { readCountedQuantity } from '@/lib/restock-typed-input';
import type { Product, ShopLocation, StockCountReason } from '@/types/models';

// A stock-take by spreadsheet.
//
// A real one is 300 lines on a clipboard at 7am, not three products typed into
// a phone -- which is why this file exists at all, and why the sheet it
// describes is walked rather than read.
//
// Pure, like restock-import.ts: this turns a parsed sheet plus what the shop
// currently holds into a plan, and the caller commits that plan through
// save_stock_count. Nothing here writes. That split is the point -- every rule
// below is testable without a database, and the commit stays a thin loop.
//
// The one rule worth stating before any code: A ROW LEFT BLANK IS A PRODUCT NOT
// COUNTED, and a product not counted keeps its number. It does not reach the
// RPC at all. The alternative -- treating a whole-store sheet as authoritative
// and zeroing anything absent -- would wipe a shop's inventory from one
// afternoon spent on aisle three.

// Five, and only five. The preview REPORTS how many differing lines have none
// ("9 with no reason"), so a sixth spelling would quietly become a sixth
// category nobody chose. The labels are what a shop reads and types; the keys
// are what stock_count_items.reason stores.
export const COUNT_REASONS: { key: StockCountReason; label: string }[] = [
  { key: 'damaged', label: 'Damaged' },
  { key: 'expired', label: 'Expired' },
  { key: 'theft_or_loss', label: 'Theft or loss' },
  { key: 'miscount', label: 'Miscount' },
  { key: 'other', label: 'Other' },
];

const REASON_LABELS = new Map(COUNT_REASONS.map((r) => [r.key, r.label]));

export function reasonLabel(key: StockCountReason): string {
  return REASON_LABELS.get(key) ?? key;
}

// The five, as a sentence, for the rejection that has to name them.
const REASON_LIST = 'Damaged, Expired, Theft or loss, Miscount or Other';

// Accepts the label a shop reads off the screen, however they capitalise it,
// and the stored key too -- a sheet that has been round-tripped through an
// export, or a person copying what they saw in a report, both arrive with the
// underscore form. Anything else is `'unknown'`, which is rejected by name
// rather than dropped: a misspelt reason silently becoming "no reason" would
// show up in the preview as a shop failing to explain something they did.
function readReason(text: string): StockCountReason | null | 'unknown' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const key = trimmed.toLowerCase();
  const match = COUNT_REASONS.find((r) => r.key === key || r.label.toLowerCase() === key);
  return match ? match.key : 'unknown';
}

export const COUNT_TEMPLATE_COLUMNS: TemplateColumn[] = [
  { header: 'Product', required: true },
  { header: 'SKU', required: false },
  { header: 'Barcode', required: false },
  { header: 'Store', required: true },
  // Not read back. It is on the sheet so the walk has an order and so the
  // walker can find the shelf named on the row -- and `countSheetRows` sorts by
  // it, which is the actual feature.
  { header: 'Shelf', required: false },
  // Also not read back. Stated so the counter can see what they are
  // contradicting, and deliberately ignored on upload: it was true when the
  // sheet was downloaded, and a week of trading may have happened since.
  { header: 'App says', required: false },
  { header: 'Counted', required: true },
  { header: 'Reason', required: false },
];

// One line per product per store, for the products that store CARRIES.
//
// The deliberate opposite of restockSheetRows, which lists every product at
// every store INCLUDING the ones a store holds none of -- because a product at
// zero is the likeliest thing in the van. A stock-take is the other case: a
// product with no stock row at that store has no shelf to walk to, and 200 rows
// of things that are not in the room is how a 300-line sheet becomes a 500-line
// one. `listProducts(shopId, locationId)` already draws exactly this line, and
// keeps rows sitting at zero -- "we stock this and we're out" is a shelf worth
// looking at.
export type CountSheetRow = {
  product: Product;
  location: ShopLocation;
  stock: number;
  // The store's own shelf label for this product. Per store, not per product:
  // the same item sits in a different place in each branch
  // (product_location_stock.shelf_number, migration 20260810000000).
  shelfNumber: string | null;
};

export const COUNT_SHEET_COLUMNS: CsvColumn<CountSheetRow>[] = [
  { header: 'Product', value: (r) => r.product.name },
  { header: 'SKU', value: (r) => r.product.sku ?? '' },
  { header: 'Barcode', value: (r) => r.product.barcode ?? '' },
  // The code when there is one, so a store rename cannot orphan a sheet
  // someone downloaded last week -- which is what `code` is for.
  { header: 'Store', value: (r) => r.location.code || r.location.name },
  { header: 'Shelf', value: (r) => r.shelfNumber ?? '' },
  { header: 'App says', value: (r) => String(r.stock) },
  { header: 'Counted', value: () => '' },
  { header: 'Reason', value: () => '' },
];

// Natural order, so A3 comes before A10 rather than after A1 and before A2.
// A shelf label is a place in a room, and plain string ordering sends the
// walker back down the aisle. Rows with no shelf sort LAST: an unshelved
// product is the one hunted for at the end of the walk, and putting it at the
// top would start every stock-take with the items nobody can find.
function compareShelf(a: string | null, b: string | null): number {
  const left = a?.trim() ?? '';
  const right = b?.trim() ?? '';
  if (left === '' && right === '') return 0;
  if (left === '') return 1;
  if (right === '') return -1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

// Sorted by shelf, not by name -- the single decision this sheet turns on.
//
// The restock sheet comes back in whatever order the catalogue does, because a
// delivery is unpacked from a box and the box has no order. A stock-take is
// WALKED, shelf by shelf, and a sheet in the order of the room is the
// difference between an hour and an afternoon.
//
// Store first, because shelf order across two stores is meaningless -- A3 in
// one branch is not near A3 in another. Store order is the caller's
// `locations` order (primary first, as the session hands it over) rather than
// anything derived, so the sheet opens on the store most shops are standing in.
export function countSheetRows(locations: ShopLocation[], entries: CountSheetRow[]): CountSheetRow[] {
  const stores = locations.filter((location) => location.active);
  const rank = new Map(stores.map((location, index) => [location.id, index]));
  return entries
    .filter((entry) => rank.has(entry.location.id))
    .slice()
    .sort(
      (a, b) =>
        rank.get(a.location.id)! - rank.get(b.location.id)! ||
        compareShelf(a.shelfNumber, b.shelfNumber) ||
        a.product.name.localeCompare(b.product.name)
    );
}

// --- Planning -------------------------------------------------------------

export type PlannedCountLine = {
  productId: string;
  productName: string;
  // What the app believes RIGHT NOW -- read from the caller's live `stockAt`,
  // never from the sheet's own "App says" column, which was true when the file
  // was downloaded. The RPC reads it a third time under a row lock at commit,
  // and that third reading is the one recorded: a sale completing while the
  // shop reads the preview must not be absorbed into the variance.
  previousQuantity: number;
  countedQuantity: number;
  variance: number;
  // null means the shop did not say, and it stays null all the way to the
  // column. Never defaulted to 'miscount' -- that is a precise-looking answer
  // to a question nobody asked.
  reason: StockCountReason | null;
  // What a unit costs today, or null where the product is uncosted. Null, never
  // zero: zero is a real answer (a free sample), which is the distinction
  // isUncosted exists to keep. Carried so the preview can value the shortfall
  // -- and, where it cannot, say so instead of quoting a smaller number.
  unitCostCents: number | null;
};

// One save_stock_count call. Lines are grouped by store because that RPC counts
// exactly one store per transaction -- and a shop reading its history should see
// one stock-take per store, not two blurred into one.
export type PlannedCount = {
  locationId: string;
  locationName: string;
  lines: PlannedCountLine[];
};

export type CountPlan = {
  counts: PlannedCount[];
  rejected: RejectedRow[];
  // Rows with nothing filled in. Counted rather than rejected, and NOT counted
  // as a line: the sheet is a download of everything the store carries, so most
  // of it is meant to come back untouched, and a product nobody counted keeps
  // its number.
  skipped: number;
};

export function planLines(plan: CountPlan): PlannedCountLine[] {
  return plan.counts.flatMap((count) => count.lines);
}

// Why `readCountedQuantity` refused a cell, in the shop's words.
//
// This chooses a SENTENCE and nothing else -- what is accepted is decided by
// readCountedQuantity alone, so the sheet and the by-hand field cannot drift
// apart. (The restock branch shipped exactly that drift twice: an unbounded
// sheet parser beside a capped by-hand one, and two different readings of
// "1,50" ending at the same column.)
function quantityRejection(text: string): string {
  const trimmed = text.trim();
  if (/^-[0-9]+$/.test(trimmed)) {
    return 'Counted cannot be negative — write down how many you found, and 0 if the shelf was empty.';
  }
  // Digits only, so the cell was a number -- just not one the column can hold.
  // Told apart from gibberish because the two ask for different corrections.
  if (/^[0-9]+$/.test(trimmed)) {
    return 'Counted is larger than a count can be — check for a stray digit or a pasted cell.';
  }
  return 'Counted must be a whole number — just the digits, with no units.';
}

function findLocation(locations: ShopLocation[], text: string): ShopLocation | undefined {
  const key = text.trim().toLowerCase();
  return locations.find((l) => l.name.trim().toLowerCase() === key || (l.code ?? '').trim().toLowerCase() === key);
}

// SKU first, then barcode, then name -- identical to the restock and move
// sheets, and for the same reasons: the identifiers survive someone tidying a
// name in a spreadsheet, and a name is the only one of the three that two
// products can share.
function findProduct(products: Product[], row: Record<string, string>): Product | 'none' | 'ambiguous' {
  const sku = row['SKU']?.trim().toLowerCase();
  if (sku) {
    const bySku = products.filter((p) => (p.sku ?? '').trim().toLowerCase() === sku);
    if (bySku.length === 1) return bySku[0];
    if (bySku.length > 1) return 'ambiguous';
  }

  const barcode = normalizeBarcode(row['Barcode'] ?? '').toLowerCase();
  if (barcode) {
    const byBarcode = products.filter((p) => normalizeBarcode(p.barcode ?? '').toLowerCase() === barcode);
    if (byBarcode.length === 1) return byBarcode[0];
    if (byBarcode.length > 1) return 'ambiguous';
  }

  const name = row['Product']?.trim().toLowerCase();
  if (!name) return 'none';
  const byName = products.filter((p) => p.name.trim().toLowerCase() === name);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return 'ambiguous';
  return 'none';
}

export function planCount(
  parsed: ParsedCsv,
  context: {
    products: Product[];
    locations: ShopLocation[];
    stockAt: (productId: string, locationId: string) => number;
  }
): CountPlan {
  const stores = context.locations.filter((location) => location.active);
  const storeNames = stores.map((l) => l.name).join(', ');

  const rejected: RejectedRow[] = [];
  const byStore = new Map<string, PlannedCount>();
  // (product, store) -> the row that already counted it. Two rows counting the
  // same product at the same store are almost always a copy-paste slip, and one
  // of them would silently win -- the shop would read one number on screen and
  // find another on the shelf.
  const claimed = new Map<string, number>();
  let skipped = 0;

  parsed.rows.forEach((raw, i) => {
    const row = i + 2; // the header occupies row 1 of the uploaded file
    const reject = (reason: string) => rejected.push({ row, reason, data: raw });

    const countedText = raw['Counted']?.trim() ?? '';
    const reasonText = raw['Reason']?.trim() ?? '';
    // An untouched row. Not a rejection and not a line: this product was not
    // counted, and a product that was not counted keeps its number.
    if (!countedText && !reasonText) {
      skipped += 1;
      return;
    }
    if (!countedText) {
      return reject('Reason is filled in but Counted is empty — write down what you found.');
    }

    const product = findProduct(context.products, raw);
    if (product === 'none') {
      return reject(
        `No product matches "${raw['Product']?.trim() || raw['SKU']?.trim() || raw['Barcode']?.trim() || ''}" — check the spelling, or fill in the SKU column. If you don't sell it yet, use Import products, which creates it with its price and opening stock.`
      );
    }
    if (product === 'ambiguous') {
      return reject(`More than one product matches "${raw['Product']?.trim()}" — fill in the SKU column to say which.`);
    }

    const store = findLocation(stores, raw['Store'] ?? '');
    if (!store) {
      return reject(
        raw['Store']?.trim()
          ? `No active store called "${raw['Store'].trim()}". Your stores are ${storeNames}.`
          : 'Store is empty — say which store you counted.'
      );
    }

    // Read by readCountedQuantity, the SAME function the by-hand tab's Counted
    // field uses -- one reader means one answer, and in particular one ceiling
    // and one treatment of zero.
    const countedQuantity = readCountedQuantity(countedText);
    if (countedQuantity === null) return reject(quantityRejection(countedText));

    const claim = `${product.id}|${store.id}`;
    const earlier = claimed.get(claim);
    if (earlier !== undefined) {
      return reject(`Row ${earlier} already counts ${product.name} at ${store.name} — combine them into one row.`);
    }

    const reason = readReason(reasonText);
    if (reason === 'unknown') {
      return reject(`"${reasonText}" is not one of the reasons. Use ${REASON_LIST}, or leave it empty.`);
    }

    claimed.set(claim, row);

    const previousQuantity = context.stockAt(product.id, store.id);
    const count = byStore.get(store.id) ?? { locationId: store.id, locationName: store.name, lines: [] };
    count.lines.push({
      productId: product.id,
      productName: product.name,
      previousQuantity,
      countedQuantity,
      variance: countedQuantity - previousQuantity,
      // A reason on a line whose count MATCHED is kept, not dropped and not
      // rejected. It is the shop's own word about a product they looked at, the
      // column has room for it, and rejecting the row would block a 300-line
      // stock-take over a cell that changes no number.
      reason,
      unitCostCents: isUncosted(product) ? null : product.costCents,
    });
    byStore.set(store.id, count);
  });

  return { counts: [...byStore.values()], rejected, skipped };
}

// --- What it adds up to ---------------------------------------------------

export type CountSummary = {
  counted: number;
  matched: number;
  differ: number;
  // Net, signed, in units. The footer says "−1 unit", not "3 lost, 2 found",
  // so nobody reads a good day into a stock-take that lost three of one thing
  // and found two of another.
  varianceUnits: number;
  // Net, signed, in cents. Null when any DIFFERING line is uncosted: the honest
  // answer there is no answer, and a smaller number would be a lie with a
  // decimal point in it.
  varianceCents: number | null;
  // Gross, positive, in cents -- only the lines that came up SHORT. This is a
  // different question from varianceCents and it has a different answer: the
  // mockup's own frame nets to −$4.61 and offers $13.83, because two units that
  // turned up are not a refund. Null when any line that came up short is
  // uncosted, for the same reason as above.
  shortfallCents: number | null;
  uncostedDifferingLines: number;
  uncostedShortfallLines: number;
  // Lines that differ with no reason given. Reported, never filled -- a shop
  // that sees this figure every month knows something the app cannot tell it.
  reasonlessLines: number;
};

export function summariseCount(lines: PlannedCountLine[]): CountSummary {
  const differing = lines.filter((line) => line.variance !== 0);
  const short = lines.filter((line) => line.variance < 0);
  const uncostedDifferingLines = differing.filter((line) => line.unitCostCents === null).length;
  const uncostedShortfallLines = short.filter((line) => line.unitCostCents === null).length;

  return {
    counted: lines.length,
    matched: lines.length - differing.length,
    differ: differing.length,
    varianceUnits: lines.reduce((sum, line) => sum + line.variance, 0),
    // Guarded on the uncosted COUNT rather than written as `.every()`: `every`
    // on an empty array is true, and the equivalent shortcut on the restock
    // sheet reported an empty basket as a delivery worth 0.00 -- which the
    // expense checkbox then offered to log. Here an empty list genuinely is
    // worth nothing, and it reaches that answer by adding nothing up rather
    // than by passing a test it should not have been given.
    varianceCents:
      uncostedDifferingLines > 0
        ? null
        : differing.reduce((sum, line) => sum + line.variance * (line.unitCostCents ?? 0), 0),
    shortfallCents:
      uncostedShortfallLines > 0
        ? null
        : short.reduce((sum, line) => sum + -line.variance * (line.unitCostCents ?? 0), 0),
    uncostedDifferingLines,
    uncostedShortfallLines,
    reasonlessLines: differing.filter((line) => line.reason === null).length,
  };
}
