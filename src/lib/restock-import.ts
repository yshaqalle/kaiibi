import { normalizeBarcode } from '@/lib/barcode';
import type { CsvColumn, ParsedCsv } from '@/lib/csv';
import type { RejectedRow, TemplateColumn } from '@/lib/import-shared';
import { readTypedCost, readTypedQuantity } from '@/lib/restock-typed-input';
import type { Product, ShopLocation } from '@/types/models';

// Taking in a delivery by spreadsheet.
//
// The fourth stock job, and the one that had no tool: Import creates products,
// Move relocates them, the inline stepper corrects one count. Nothing ADDED
// units to something the shop already sells, so shops improvised -- and the
// improvisations (re-importing a catalogue, or re-importing it under tweaked
// names) are exactly the double-counting stock-move-import.ts was written to
// stop, arriving through a different door.
//
// Pure, like its sibling: this turns a parsed sheet plus what the shop
// currently holds into a plan, and the caller commits that plan through
// receive_stock. Nothing here writes. That split is the point -- every rule
// below is testable without a database, and the commit stays a thin loop.

export const RESTOCK_TEMPLATE_COLUMNS: TemplateColumn[] = [
  { header: 'Product', required: true },
  { header: 'SKU', required: false },
  { header: 'Barcode', required: false },
  { header: 'Store', required: true },
  { header: 'Quantity now', required: false },
  { header: 'Quantity received', required: true },
  { header: 'Unit cost', required: false },
  { header: 'Note', required: false },
];

// One line per product per store, including stores holding NONE of it.
//
// The exact inverse of stockMoveSheetRows, and the difference is the whole
// distinction between the two jobs: you cannot move what isn't there, so the
// move sheet drops zero rows to stop them burying the movable ones. A product
// at zero is the most likely thing in the van, so dropping it here would hide
// precisely what the shop came to type.
export type RestockSheetRow = {
  product: Product;
  location: ShopLocation;
  stock: number;
};

export const RESTOCK_SHEET_COLUMNS: CsvColumn<RestockSheetRow>[] = [
  { header: 'Product', value: (r) => r.product.name },
  { header: 'SKU', value: (r) => r.product.sku ?? '' },
  { header: 'Barcode', value: (r) => r.product.barcode ?? '' },
  // The code when there is one, so a store rename cannot orphan a sheet
  // someone downloaded last week -- which is what `code` is for.
  { header: 'Store', value: (r) => r.location.code || r.location.name },
  { header: 'Quantity now', value: (r) => String(r.stock) },
  { header: 'Quantity received', value: () => '' },
  { header: 'Unit cost', value: () => '' },
  { header: 'Note', value: () => '' },
];

export function restockSheetRows(
  products: Product[],
  locations: ShopLocation[],
  stockAt: (productId: string, locationId: string) => number
): RestockSheetRow[] {
  const stores = locations.filter((location) => location.active);
  const rows: RestockSheetRow[] = [];
  for (const product of products) {
    for (const location of stores) {
      rows.push({ product, location, stock: stockAt(product.id, location.id) });
    }
  }
  return rows;
}

// --- Planning -------------------------------------------------------------

export type PlannedReceiptItem = {
  productId: string;
  productName: string;
  quantity: number;
  // null means the sheet did not say, and the product's cost stays as it is.
  unitCostCents: number | null;
  // What the app holds today, carried so the preview can say "4.50 → 4.80"
  // before anything is written. Overwriting a cost silently is how stock at
  // cost and gross profit change under a shop without it noticing.
  previousCostCents: number | null;
};

// One receive_stock call. Rows are grouped by store because that RPC receives
// into exactly one store per transaction -- and a shop reading its history
// should see one delivery per store, not two blurred into one.
export type PlannedReceipt = {
  locationId: string;
  locationName: string;
  items: PlannedReceiptItem[];
  supplierName: string | null;
  reference: string | null;
  note: string | null;
};

// A receipt far larger than the store has ever held. Reported, never rejected:
// this is the shape of a misplaced decimal or a case-vs-unit mix-up, and it is
// also the shape of a pallet that really did arrive.
export type OversizedReceipt = {
  productName: string;
  locationName: string;
  quantity: number;
  held: number;
};

export type RestockPlan = {
  receipts: PlannedReceipt[];
  rejected: RejectedRow[];
  // Rows with nothing filled in. Counted rather than rejected: the sheet is a
  // download of the whole catalogue, so most of it is MEANT to come back
  // untouched. Reporting 210 rejections for a file that did exactly what was
  // asked would bury the one row that is genuinely wrong.
  skipped: number;
  oversized: OversizedReceipt[];
};

// How much bigger than the store's current holding a receipt has to be before
// it is worth mentioning. Ten is high enough that ordinary restocking never
// trips it and low enough to catch a decimal slip.
const OVERSIZED_MULTIPLE = 10;

// Why `readTypedQuantity` refused a cell, in the shop's words.
//
// This chooses a SENTENCE and nothing else -- what is accepted is decided by
// readTypedQuantity alone, so the sheet and the by-hand field cannot drift
// apart again. (They had: this module's own `parseWholeNumber` was unbounded,
// so "9999999999" planned and previewed cleanly and then failed inside the RPC
// with a raw `value "9999999999" is out of range for type integer` -- after the
// stores earlier in commitPlan's loop had already committed.)
function quantityRejection(text: string): string {
  const trimmed = text.trim();
  // Restock only ever adds units, so a negative or a zero cell is asking for
  // a different job -- setting the shelf to what is actually there, which is
  // Count's job, not this sheet's. Name the door: Count ships from the same
  // Stock sheet this one does.
  if (/^-[0-9]+$/.test(trimmed)) {
    return 'Restock only adds. To reduce a count, use Count.';
  }
  if (/^0+$/.test(trimmed)) {
    return 'Quantity received is 0, which would change nothing. Leave the cell empty to skip the row, or use Count to set a total.';
  }
  // Digits only, so the cell was a number -- just not one the column can hold.
  // Told apart from gibberish because the two ask for different corrections.
  if (/^[0-9]+$/.test(trimmed)) {
    return 'Quantity received is larger than a delivery can be — check for a stray digit or a pasted cell.';
  }
  return 'Quantity received must be a whole number — just the digits, with no units.';
}

function findLocation(locations: ShopLocation[], text: string): ShopLocation | undefined {
  const key = text.trim().toLowerCase();
  // A blank cell must never match. Codeless stores are the norm (a code is
  // optional, saved as null rather than ''), so an empty key would otherwise
  // find the first active store with no code at all and receive the delivery
  // into it -- exactly the store the shop never named.
  if (!key) return undefined;
  return locations.find((l) => l.name.trim().toLowerCase() === key || (l.code ?? '').trim().toLowerCase() === key);
}

// SKU first, then barcode, then name -- identical to the move sheet, and for
// the same reasons: the identifiers survive someone tidying a name in a
// spreadsheet, and a name is the only one of the three two products can share.
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

export function planRestock(
  parsed: ParsedCsv,
  context: {
    products: Product[];
    locations: ShopLocation[];
    stockAt: (productId: string, locationId: string) => number;
  }
): RestockPlan {
  const stores = context.locations.filter((location) => location.active);
  const storeNames = stores.map((l) => l.name).join(', ');

  const rejected: RejectedRow[] = [];
  const byStore = new Map<string, PlannedReceipt>();
  // (product, store) -> the row that already claimed it. Two rows receiving the
  // same product into the same store are almost always a copy-paste slip, and
  // silently summing them would receive twice what the shop read on screen.
  const claimed = new Map<string, number>();
  const oversized: OversizedReceipt[] = [];
  let skipped = 0;

  parsed.rows.forEach((raw, i) => {
    const row = i + 2; // the header occupies row 1 of the uploaded file
    const reject = (reason: string) => rejected.push({ row, reason, data: raw });

    const quantityText = raw['Quantity received']?.trim() ?? '';
    const costText = raw['Unit cost']?.trim() ?? '';
    const noteText = raw['Note']?.trim() ?? '';
    if (!quantityText && !costText && !noteText) {
      skipped += 1;
      return;
    }
    if (!quantityText) {
      return reject(
        costText
          ? 'Unit cost is filled in but Quantity received is empty — say how many arrived.'
          : 'Note is filled in but Quantity received is empty — say how many arrived.'
      );
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
          : 'Store is empty — say which store the delivery arrived at.'
      );
    }

    // Read by readTypedQuantity, the SAME function the by-hand tab's Received
    // field uses -- for the same reason the Unit cost column is read by
    // readTypedCost below. One reader means one answer, and in particular one
    // ceiling: stock_receipt_items.quantity is a Postgres `integer`
    // (20260902000000_stock_receipts.sql:45), and a cell past it has to be
    // caught here, while nothing has been written, rather than inside the RPC
    // halfway through a multi-store commit.
    const quantity = readTypedQuantity(quantityText);
    if (quantity === null) return reject(quantityRejection(quantityText));

    const claim = `${product.id}|${store.id}`;
    const earlier = claimed.get(claim);
    if (earlier !== undefined) {
      return reject(`Row ${earlier} already receives ${product.name} into ${store.name} — combine them into one row.`);
    }

    // Read by readTypedCost, the SAME function the by-hand tab's cost field
    // uses. Both routes end at products.cost_cents, so a shop that types 1,50
    // by hand and 1,50 in a sheet must get one answer -- and until this line
    // they got two, $1.50 and $150.00, with nothing on either screen to say
    // which one it had taken.
    //
    // Nothing is given up by sharing it. The two properties this module's own
    // parser was kept separate for are both in readTypedCost already: it
    // strips stray currency symbols before reading (so "$4.80" is still 480),
    // and a cell with no digits at all ("n/a", "TBD", an em dash) reads as
    // unreadable rather than as a genuine zero. What it adds is the whole
    // reason it exists -- the separator question. "1,50" was 15000c and is
    // now 150c. "1.234,56" was NOT rejected here -- stripping its comma left
    // "1.23456", which Number() reads as 1.23456, not NaN, so this silently
    // wrote 123c ($1.23) into products.cost_cents for a €1,234.56 delivery.
    // It is now 123456c.
    //
    // It also closes two cells that used to reach the server raw: a minus sign
    // is refused by name rather than filtered into a negative that trips the
    // unit_cost_cents >= 0 check, and an amount past a Postgres integer is
    // told apart from an unreadable one instead of failing with "integer out
    // of range" on a screen that had been explaining itself in sentences.
    let unitCostCents: number | null = null;
    if (costText) {
      const cost = readTypedCost(costText);
      if (cost.kind !== 'cents') {
        return reject(
          cost.kind === 'unreadable' && cost.reason === 'too-large'
            ? 'Unit cost is larger than a cost can be — check the decimal point.'
            : 'Unit cost must be an amount of money, like 4.80 — or leave it empty to keep the cost you have.'
        );
      }
      unitCostCents = cost.cents;
    }

    const held = context.stockAt(product.id, store.id);
    // Only where the store has held some before: the first delivery of
    // something a store carries none of has no baseline to be out of scale
    // with, and warning about it would fire on every genuinely new line.
    if (held > 0 && quantity >= held * OVERSIZED_MULTIPLE) {
      oversized.push({ productName: product.name, locationName: store.name, quantity, held });
    }

    claimed.set(claim, row);

    const receipt = byStore.get(store.id) ?? {
      locationId: store.id,
      locationName: store.name,
      items: [],
      supplierName: null,
      reference: null,
      note: null,
    };
    receipt.items.push({
      productId: product.id,
      productName: product.name,
      quantity,
      unitCostCents,
      previousCostCents: product.costCents,
    });
    // The first note given for a store stands for the whole receipt: one
    // stock_receipts row is written per store, so there is only one note
    // column to write. A second note for the same store IS lost silently --
    // there is no rejection, no warning, nothing in RestockPlan that carries
    // it -- accepted because the schema has room for exactly one note per
    // receipt and the alternative (rejecting the row) would block a delivery
    // over a field that does not change what was received.
    if (!receipt.note && noteText) receipt.note = noteText;
    byStore.set(store.id, receipt);
  });

  return { receipts: [...byStore.values()], rejected, skipped, oversized };
}

export function receivedUnits(receipt: PlannedReceipt): number {
  return receipt.items.reduce((total, item) => total + item.quantity, 0);
}

// Every line whose cost the commit would actually change. Restating the cost
// the app already holds is not a change, and listing it would bury the ones
// that are.
export function costUpdates(plan: RestockPlan): PlannedReceiptItem[] {
  return plan.receipts.flatMap((receipt) =>
    receipt.items.filter((item) => item.unitCostCents !== null && item.unitCostCents !== item.previousCostCents)
  );
}

// The same list, ready to read: which product, at which store, from what to
// what -- and whether this one sheet gives that product two different costs.
export type CostChange = {
  productId: string;
  productName: string;
  locationName: string;
  /** What the app holds today. Null means it holds none, so this is the first. */
  previousCostCents: number | null;
  costCents: number;
  /**
   * True when the same product is given a DIFFERENT cost somewhere else in this
   * plan. products.cost_cents is one column per product with no store dimension,
   * so both writes land on it.
   *
   * Until 20260907000000_moving_weighted_average.sql that meant the last store
   * through the commit loop was the one that stuck -- silently, and in a store
   * order the shop never chose. receive_stock averages now, so both costs are
   * blended into the one column instead and the store order no longer decides
   * the answer (averaging is commutative up to rounding). Still worth flagging:
   * a product deliberately priced two ways in one sheet is usually a mistake in
   * the sheet, and a neutral pair of rows would show it as two ordinary
   * updates.
   */
  conflicting: boolean;
};

export function costChanges(plan: RestockPlan): CostChange[] {
  const rows = plan.receipts.flatMap((receipt) =>
    receipt.items
      .filter((item) => item.unitCostCents !== null && item.unitCostCents !== item.previousCostCents)
      .map((item) => ({
        productId: item.productId,
        productName: item.productName,
        locationName: receipt.locationName,
        previousCostCents: item.previousCostCents,
        costCents: item.unitCostCents!,
      }))
  );
  const costsPerProduct = new Map<string, Set<number>>();
  for (const row of rows) {
    const seen = costsPerProduct.get(row.productId) ?? new Set<number>();
    seen.add(row.costCents);
    costsPerProduct.set(row.productId, seen);
  }
  return rows.map((row) => ({ ...row, conflicting: (costsPerProduct.get(row.productId)?.size ?? 0) > 1 }));
}
