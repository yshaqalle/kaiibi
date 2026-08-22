import { normalizeBarcode } from '@/lib/barcode';
import type { CsvColumn, ParsedCsv } from '@/lib/csv';
import type { RejectedRow, TemplateColumn } from '@/lib/import-shared';
import type { Product, ShopLocation } from '@/types/models';

// Moving stock between stores by spreadsheet.
//
// Shops were reaching for product import to redistribute stock, because it was
// the only bulk tool on the Inventory screen -- and importing a catalogue a
// second time to stock another store INFLATES the count: the same units, counted
// twice. This is the operation they actually wanted. Everything here is pure:
// it turns a parsed sheet plus what the shop currently holds into a plan, and
// the caller commits that plan through transfer_stock.
//
// Nothing in this module writes. That split is the point -- every rule below is
// testable without a database, and the commit stays a thin loop over the pairs.

export const STOCK_MOVE_TEMPLATE_COLUMNS: TemplateColumn[] = [
  { header: 'Product', required: true },
  { header: 'SKU', required: false },
  { header: 'Barcode', required: false },
  { header: 'From store', required: true },
  { header: 'Quantity now', required: false },
  { header: 'To store', required: true },
  { header: 'Quantity to move', required: true },
  { header: 'Note', required: false },
];

// One line per product per store that HOLDS it, so "move 5 out of Jaalala
// Skincare" is unambiguous. The alternative -- one line per product with a From
// the shop fills in itself -- is shorter and asks the user to restate something
// the app already knows, which is where the mistakes come from.
//
// `Quantity now` is filled and `To store`/`Quantity to move` are left blank:
// the blank cells are the shop's half of the exchange, and a sheet where the
// cells to fill are visibly empty needs no instructions.
export type StockMoveSheetRow = {
  product: Product;
  location: ShopLocation;
  stock: number;
};

export const STOCK_MOVE_SHEET_COLUMNS: CsvColumn<StockMoveSheetRow>[] = [
  { header: 'Product', value: (r) => r.product.name },
  { header: 'SKU', value: (r) => r.product.sku ?? '' },
  { header: 'Barcode', value: (r) => r.product.barcode ?? '' },
  // The code, when there is one, because a store rename must not orphan a
  // sheet someone downloaded last week -- which is what `code` is for.
  { header: 'From store', value: (r) => r.location.code || r.location.name },
  { header: 'Quantity now', value: (r) => String(r.stock) },
  { header: 'To store', value: () => '' },
  { header: 'Quantity to move', value: () => '' },
  { header: 'Note', value: () => '' },
];

// What the download hands over: every (product, store) pair holding at least one
// unit. Zero-stock rows are left out -- you cannot move what isn't there, and
// including them would bury the movable rows in a full catalogue. A shop that
// wants the whole catalogue has Export CSV for that.
export function stockMoveSheetRows(
  products: Product[],
  locations: ShopLocation[],
  stockAt: (productId: string, locationId: string) => number
): StockMoveSheetRow[] {
  const stores = locations.filter((location) => location.active);
  const rows: StockMoveSheetRow[] = [];
  for (const product of products) {
    for (const location of stores) {
      const stock = stockAt(product.id, location.id);
      if (stock > 0) rows.push({ product, location, stock });
    }
  }
  return rows;
}

// --- Planning -------------------------------------------------------------

export type PlannedMoveItem = { productId: string; productName: string; quantity: number };

// One transfer_stock call. Rows are grouped by store pair because that RPC
// moves between exactly two stores in one transaction -- a sheet that sends
// stock in both directions is two movements, and a shop reading its history
// should see two, not one blurred into the other.
export type PlannedMovePair = {
  fromLocationId: string;
  toLocationId: string;
  fromName: string;
  toName: string;
  items: PlannedMoveItem[];
  note: string | null;
};

export type StockMovePlan = {
  pairs: PlannedMovePair[];
  rejected: RejectedRow[];
  // Rows with no destination and no quantity. Counted rather than rejected:
  // the sheet is a download of everything the shop holds, so most of it is
  // MEANT to come back untouched. Reporting 210 rejections for a file that did
  // exactly what was asked would bury the one row that is genuinely wrong.
  skipped: number;
};

function parseWholeNumber(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

// Name, code, or either with different casing/padding -- a store typed into a
// spreadsheet by hand is not going to match byte for byte.
function findLocation(locations: ShopLocation[], text: string): ShopLocation | undefined {
  const key = text.trim().toLowerCase();
  return locations.find((l) => l.name.trim().toLowerCase() === key || (l.code ?? '').trim().toLowerCase() === key);
}

// SKU first, then barcode, then name. The identifiers win because they survive
// an edit to the Product cell -- someone who tidies a name in the spreadsheet
// has not asked for a different product -- and because a name is the only one
// of the three that two products can share.
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

const pairKey = (from: string, to: string) => `${from}->${to}`;

// Turns a parsed sheet into the moves that will be made, and the rows that
// won't. Nothing is committed here and nothing is half-planned: a row either
// joins a pair or is rejected with a reason naming what to fix.
//
// `stockAt` is what the SOURCE store currently holds. Checked here as well as
// by the RPC so the shop sees every over-quantity row at once, before anything
// moves, rather than discovering them one failed transfer at a time.
export function planStockMoves(
  parsed: ParsedCsv,
  context: {
    products: Product[];
    locations: ShopLocation[];
    stockAt: (productId: string, locationId: string) => number;
  }
): StockMovePlan {
  const stores = context.locations.filter((location) => location.active);
  const storeNames = stores.map((l) => l.name).join(', ');

  const rejected: RejectedRow[] = [];
  const byPair = new Map<string, PlannedMovePair>();
  // (product, from, to) -> the row that already claimed it. Two rows moving the
  // same product along the same route are almost always a copy-paste slip, and
  // silently summing them would move twice what the shop read on the screen.
  const claimed = new Map<string, number>();
  // Running total per (product, from), so five rows each moving 8 out of a
  // store holding 10 are caught here rather than by whichever transfer happens
  // to run second.
  const committed = new Map<string, number>();
  let skipped = 0;

  parsed.rows.forEach((raw, i) => {
    const row = i + 2; // the header occupies row 1 of the uploaded file
    const reject = (reason: string) => rejected.push({ row, reason, data: raw });

    const toText = raw['To store']?.trim() ?? '';
    const quantityText = raw['Quantity to move']?.trim() ?? '';
    if (!toText && !quantityText) {
      skipped += 1;
      return;
    }
    // Only ONE of the two filled is a half-finished row, not an untouched one.
    // Skipping it silently would drop a move the shop believes it asked for.
    if (!toText) return reject('Quantity to move is filled in but To store is empty — say which store it is going to.');
    if (!quantityText) return reject('To store is filled in but Quantity to move is empty — say how many are going.');

    const product = findProduct(context.products, raw);
    if (product === 'none') {
      return reject(
        `No product matches "${raw['Product']?.trim() || raw['SKU']?.trim() || raw['Barcode']?.trim() || ''}" — check the spelling, or fill in the SKU column. If you don't sell it yet, use Import products.`
      );
    }
    if (product === 'ambiguous') {
      return reject(`More than one product matches "${raw['Product']?.trim()}" — fill in the SKU column to say which.`);
    }

    const from = findLocation(stores, raw['From store'] ?? '');
    if (!from) {
      return reject(
        raw['From store']?.trim()
          ? `No active store called "${raw['From store'].trim()}". Your stores are ${storeNames}.`
          : 'From store is empty — say which store the stock is leaving.'
      );
    }
    const to = findLocation(stores, toText);
    if (!to) return reject(`No active store called "${toText}". Your stores are ${storeNames}.`);
    if (from.id === to.id) return reject(`From and To are both ${from.name} — nothing would move.`);

    const quantity = parseWholeNumber(quantityText);
    if (quantity === null || quantity <= 0) return reject('Quantity to move must be a whole number above zero.');

    const claim = `${product.id}|${from.id}|${to.id}`;
    const earlier = claimed.get(claim);
    if (earlier !== undefined) {
      return reject(`Row ${earlier} already moves ${product.name} from ${from.name} to ${to.name} — combine them into one row.`);
    }

    // Everything this sheet has already spoken for out of this store, so the
    // check is against what would REMAIN, not against the opening count.
    const heldKey = `${product.id}|${from.id}`;
    const available = context.stockAt(product.id, from.id) - (committed.get(heldKey) ?? 0);
    if (quantity > available) {
      return reject(
        available <= 0
          ? `${product.name} has none left at ${from.name} to move. If more has just arrived, that's a Restock, not a move.`
          : `Only ${available} at ${from.name} — the sheet asks for ${quantity}. If ${quantity} really did arrive, that's a Restock; if the shelf disagrees with the app, correct the count first.`
      );
    }

    claimed.set(claim, row);
    committed.set(heldKey, (committed.get(heldKey) ?? 0) + quantity);

    const key = pairKey(from.id, to.id);
    const pair = byPair.get(key) ?? {
      fromLocationId: from.id,
      toLocationId: to.id,
      fromName: from.name,
      toName: to.name,
      items: [],
      note: null,
    };
    pair.items.push({ productId: product.id, productName: product.name, quantity });
    // The first note given for a pair stands for the whole transfer: one
    // stock_transfers row is written per pair, so there is one note to write.
    // Later rows' notes are not lost silently -- they were never separable.
    if (!pair.note && raw['Note']?.trim()) pair.note = raw['Note'].trim();
    byPair.set(key, pair);
  });

  return { pairs: [...byPair.values()], rejected, skipped };
}

export function plannedUnits(pair: PlannedMovePair): number {
  return pair.items.reduce((total, item) => total + item.quantity, 0);
}
