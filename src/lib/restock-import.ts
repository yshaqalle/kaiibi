import { normalizeBarcode } from '@/lib/barcode';
import type { CsvColumn, ParsedCsv } from '@/lib/csv';
import type { RejectedRow, TemplateColumn } from '@/lib/import-shared';
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

function parseWholeNumber(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

// Dollars in the sheet, cents in the database -- the same conversion products
// import does, so a shop never has to think in cents. One difference from
// products import's version: this one requires at least one digit before
// stripping punctuation. Without that check, a cell with no digits at all
// (`n/a`, `TBD`, an em dash) strips down to '', and Number('') is 0 -- a
// finite number indistinguishable from a genuine zero. That would read a
// shop's "I don't know" as "this cost nothing" and silently overwrite the
// product's real cost, which is exactly what null exists to prevent.
function parseDollarsToCents(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || !/\d/.test(text)) return null;
  const n = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function findLocation(locations: ShopLocation[], text: string): ShopLocation | undefined {
  const key = text.trim().toLowerCase();
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

    const quantity = parseWholeNumber(quantityText);
    if (quantity === null) {
      return reject('Quantity received must be a whole number — just the digits, with no units.');
    }
    if (quantity <= 0) {
      return reject(
        quantity < 0
          ? 'Restock only adds. To reduce a count, use Count.'
          : 'Quantity received is 0, which would change nothing. Leave the cell empty to skip the row, or use Count to set a total.'
      );
    }

    const claim = `${product.id}|${store.id}`;
    const earlier = claimed.get(claim);
    if (earlier !== undefined) {
      return reject(`Row ${earlier} already receives ${product.name} into ${store.name} — combine them into one row.`);
    }

    let unitCostCents: number | null = null;
    if (costText) {
      unitCostCents = parseDollarsToCents(costText);
      if (unitCostCents === null || unitCostCents < 0) {
        return reject('Unit cost must be an amount of money, like 4.80 — or leave it empty to keep the cost you have.');
      }
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
// that are -- which is what makes this list safe to show as a plain count.
export function costUpdates(plan: RestockPlan): PlannedReceiptItem[] {
  return plan.receipts.flatMap((receipt) =>
    receipt.items.filter((item) => item.unitCostCents !== null && item.unitCostCents !== item.previousCostCents)
  );
}
