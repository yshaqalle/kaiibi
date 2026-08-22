import { normalizeBarcode } from '@/lib/barcode';
import { createBrand } from '@/lib/brands';
import { createCategory } from '@/lib/categories';
import { hasMultipleLocations } from '@/lib/location-selection';
import type { ParsedCsv } from '@/lib/csv';
import type { ImportReport, RejectedRow } from '@/lib/import-shared';
import { createProducts, listProducts } from '@/lib/products';
import { createTag } from '@/lib/tags';
import type { NewProductInput, Product, ShopLocation } from '@/types/models';

export const PRODUCTS_TEMPLATE_COLUMNS: { header: string; required: boolean }[] = [
  { header: 'Name', required: true },
  { header: 'SKU', required: false },
  { header: 'Barcode', required: false },
  { header: 'Brand', required: false },
  { header: 'Category', required: false },
  { header: 'Tags', required: false },
  { header: 'Supplier', required: false },
  { header: 'Cost', required: false },
  { header: 'Price', required: true },
  { header: 'Stock', required: true },
  { header: 'Reorder Level', required: false },
  { header: 'Shelf Number', required: false },
  { header: 'Expiry Date', required: false },
  { header: 'Batch Number', required: false },
];

// Cost/Price are plain dollar amounts (e.g. "12.99"), not cents -- converted
// on the way in/out so a spreadsheet-editing user never has to think in cents.
// Tags support either ; or , as a separator within the cell.
//
// Two rows, because the templates are one demo shop rather than five unrelated
// examples: the sales template rings up BOTH of these (the t-shirt by SKU, the
// scarf by name), the same way its customer is the customers template's
// customer and the schedule template's email is the staff template's staff
// member. Downloading every template and importing them in order has to
// actually work -- a sales template naming a product no products template
// creates rejects itself.
//
// The scarf doubles as the "only the required columns filled" example, which
// the single t-shirt row never showed.
export const PRODUCTS_EXAMPLE_ROWS: Record<string, string>[] = [
  {
    Name: 'Blue Cotton T-Shirt',
    SKU: 'TSHIRT-BLU-M',
    Barcode: '012345678905',
    Brand: 'Acme',
    Category: 'Apparel',
    Tags: 'summer;bestseller',
    Supplier: 'Acme Wholesale',
    Cost: '4.50',
    Price: '12.99',
    Stock: '25',
    'Reorder Level': '5',
    'Shelf Number': 'A3',
    'Expiry Date': '',
    'Batch Number': '',
  },
  {
    Name: 'Wool Scarf',
    SKU: 'SCARF-WOOL',
    Barcode: '',
    Brand: '',
    Category: 'Apparel',
    Tags: '',
    Supplier: '',
    Cost: '',
    Price: '8.00',
    Stock: '10',
    'Reorder Level': '',
    'Shelf Number': '',
    'Expiry Date': '',
    'Batch Number': '',
  },
];

function parseDollarsToCents(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const n = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function parseWholeNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

// Where someone who reached product import by mistake should have gone
// instead, as `CsvImportModal`'s `elsewhere` list.
//
// TWO doors, and the app cannot pick between them. The rejection fires on one
// condition -- you already carry this product -- and that identical row means
// "40 more of these just arrived" (Restock) or "I want these at the second
// branch" (Move) depending only on what the shop is thinking. Naming Move in
// prose while offering a button for Restock alone is what this replaces: the
// shop read the right answer and had nothing to press.
//
// Restock first, because `CsvImportModal` gives the first entry the loud
// treatment and these are not equals -- more of something arriving is ordinary,
// redistributing between branches is occasional.
//
// Move only once there is a second store. A single-store shop has nowhere to
// move TO, so the control would be a dead end -- the same gate as the Stock
// door's own Move row (`showMove`) and the inventory header's Move pill. That
// shop must keep seeing exactly one control.
//
// The labels name the SITUATION, not the tool: someone who picked the wrong
// door does not yet know that "Restock" and "Move" are the words for what they
// want. No trailing arrow -- `CsvImportModal` appends it.
//
// Takes the stores rather than a `multiStore` boolean for two reasons. It puts
// the gate itself under test -- "a shop with one open branch and one closed one
// is a single-store shop" is `hasMultipleLocations`'s rule, and a caller that
// passed `locations.length > 1` would be wrong in a way a boolean parameter
// would hide. And the React Compiler bails out of the whole inventory screen
// when a locally-derived value is handed to a call it cannot see into
// ("existing memoization could not be preserved"), which the screen's own
// `showLocationFilter` is; `locations` comes from a hook and is already frozen.
//
// Here rather than inline in inventory.tsx so the gate is reachable by a test:
// the screen it lives on cannot be rendered without auth, Supabase and a
// router, and this gate silently costing a shop its Move button is exactly the
// regression nothing else would catch.
//
// The requirement this stands in for is worded against the door's own Move
// gate (inventory.tsx's `showLocationFilter && canTransfer`). The location
// half is `hasMultipleLocations(locations)` here too -- inventory.tsx calling
// the same function a second time, not this one delegating to it -- and the
// permission half is threaded through explicitly as `canTransfer` below. That
// threading is the fix for a bug this comment used to only warn about: Task 7
// narrowed the door's Move gate to require `inventory.transfer` and, for one
// review cycle, this call did not follow -- a role holding `inventory.edit`
// but not `inventory.transfer` could reach the Move sheet from the import
// rejection list and have the RPC refuse a transfer the person had already
// built. If `showLocationFilter`'s own notion of "counts as multi-store" ever
// narrows past `hasMultipleLocations` (an active-location rule beyond "closed
// doesn't count"), this call still will not follow that on its own --
// narrowing the door's gate always means narrowing this call too.
export function productImportHatches({ locations, canTransfer, onRestock, onMove }: {
  locations: readonly ShopLocation[];
  canTransfer: boolean;
  onRestock: () => void;
  onMove: () => void;
}): { label: string; onPress: () => void }[] {
  const hatches = [{ label: 'More of something you already sell? Restock', onPress: onRestock }];
  if (hasMultipleLocations(locations) && canTransfer) {
    hatches.push({ label: 'Already sell it, want it at another store? Move', onPress: onMove });
  }
  return hatches;
}

// Rejects any row whose name, SKU or barcode collides with an existing product,
// or with an earlier row in the same file -- never auto-updates, per the
// confirmed "reject both, tell the user to update it in the app" rule.
//
// The barcode half is not merely tidy: `products_shop_barcode_key` (migration
// 20260819000000) enforces it in the database, and because createProducts()
// inserts every accepted row in one statement, a single colliding barcode would
// otherwise fail the WHOLE import with an opaque constraint error. Same reason
// the plan headroom is checked here rather than left to the trigger.
//
// `headroom` is how many more products the shop's plan allows (null =
// unlimited), and it exists because createProducts() inserts every accepted row
// in ONE statement: without a pre-flight check, a 400-row file over the cap
// comes back as a single opaque `limit_reached` with nothing imported and no
// indication of how many would have fit. Checking here turns that into "12
// imported, 388 rejected -- plan limit", which is the difference between a
// dead end and a decision.
export async function runProductsImport(
  shopId: string,
  parsed: ParsedCsv,
  options?: { headroom?: number | null }
): Promise<ImportReport<Product>> {
  const existing = await listProducts(shopId);
  const existingNames = new Set(existing.map((p) => p.name.trim().toLowerCase()));
  const existingSkus = new Set(existing.filter((p) => p.sku).map((p) => p.sku!.trim().toLowerCase()));
  // Keyed through normalizeBarcode so a stored code carrying a stray scanner
  // suffix still collides with the same code typed cleanly into a spreadsheet.
  const existingBarcodes = new Set(
    existing.map((p) => normalizeBarcode(p.barcode ?? '').toLowerCase()).filter(Boolean)
  );

  const headroom = options?.headroom ?? null;
  const rejected: RejectedRow[] = [];
  const toCreate: NewProductInput[] = [];
  const seenNames = new Set<string>();
  const seenSkus = new Set<string>();
  const seenBarcodes = new Set<string>();

  parsed.rows.forEach((raw, i) => {
    const row = i + 2; // header occupies row 1 in the uploaded file
    const reject = (reason: string) => rejected.push({ row, reason, data: raw });

    // Checked before the field validations so the reason given is the one the
    // shop can actually act on: a row past the cap is refused for being past
    // the cap, not for a missing SKU it would also have had.
    if (headroom !== null && toCreate.length >= headroom) {
      return reject(
        headroom === 0
          ? 'Your plan is at its product limit. Upgrade under Settings → Plan and billing to import more.'
          : `Only ${headroom} more product${headroom === 1 ? '' : 's'} fit on your plan. Upgrade to import the rest.`
      );
    }

    const name = raw['Name']?.trim();
    if (!name) return reject('Name is required.');
    const nameKey = name.toLowerCase();

    const sku = raw['SKU']?.trim() || null;
    const skuKey = sku?.toLowerCase();

    const barcode = normalizeBarcode(raw['Barcode'] ?? '') || null;
    const barcodeKey = barcode?.toLowerCase();

    // Named as a RESTOCK rather than as an edit. The old wording ("edit it in
    // Inventory instead of importing") answered the wrong question: the shop
    // hitting this is usually re-importing because more of the same product
    // just arrived, and doing that by re-importing the catalogue counts the
    // same units twice and inflates the shop's stock. Sending them to edit 214
    // products by hand is also not a thing anyone does. Unlike the old
    // wording, this holds for every shop -- Restock doesn't need a second
    // store, only Move does, which is why the `hasStores` option this function
    // used to take stopped being read at all and has now gone.
    //
    // Two branches, not one collapsed condition: a SKU-only collision means
    // this row's NAME is not one the shop carries -- naming it here (as the
    // collapsed version once did) tells the shop they carry a product they
    // don't, and sends them into Restock's product search to look for a name
    // that isn't there. The SKU is what actually collided, so the SKU is what
    // has to be named.
    if (existingNames.has(nameKey)) {
      return reject(`You already carry ${name}. Adding more units is a Restock — importing it again would count the same units twice.`);
    }
    if (skuKey && existingSkus.has(skuKey)) {
      return reject(`You already carry a product with SKU "${sku}". Adding more units is a Restock — importing it again would count the same units twice.`);
    }
    // Separate from the name/SKU message above because the fix is different: a
    // barcode is unique by constraint, so the only way forward is to correct
    // the code or edit the product that already owns it.
    if (barcodeKey && existingBarcodes.has(barcodeKey)) {
      return reject(`Barcode "${barcode}" already belongs to another product — edit that product in Inventory instead of importing.`);
    }
    if (seenNames.has(nameKey) || (skuKey && seenSkus.has(skuKey)) || (barcodeKey && seenBarcodes.has(barcodeKey))) {
      return reject('Duplicate of an earlier row in this file.');
    }

    const priceCents = parseDollarsToCents(raw['Price']);
    if (priceCents === null || priceCents < 0) return reject('Price is required and must be a number (e.g. 12.99).');

    const stock = parseWholeNumber(raw['Stock']);
    if (stock === null || stock < 0) return reject('Stock is required and must be a whole number.');

    seenNames.add(nameKey);
    if (skuKey) seenSkus.add(skuKey);
    if (barcodeKey) seenBarcodes.add(barcodeKey);

    toCreate.push({
      name,
      description: null,
      sku,
      barcode,
      brand: raw['Brand']?.trim() || null,
      category: raw['Category']?.trim() || null,
      tags: (raw['Tags'] ?? '').split(/[;,]/).map((t) => t.trim()).filter(Boolean),
      supplierName: raw['Supplier']?.trim() || null,
      costCents: parseDollarsToCents(raw['Cost']),
      priceCents,
      stock,
      reorderLevel: parseWholeNumber(raw['Reorder Level']),
      shelfNumber: raw['Shelf Number']?.trim() || null,
      expiryDate: raw['Expiry Date']?.trim() || null,
      batchNumber: raw['Batch Number']?.trim() || null,
      imageUrl: null,
      isListedOnline: false,
    });
  });

  const accepted = toCreate.length > 0 ? await createProducts(shopId, toCreate) : [];
  await registerNames(shopId, toCreate);
  return { accepted, rejected };
}

// Gives the brand/category/tag names an imported file introduced a row of their
// own, which is what the product form has always done for a name typed by hand
// (see product-form.tsx) and what this import never did.
//
// It matters because those tables are not a cache of what's on the products --
// they ARE the list. POS builds its filter row from listCategories(), so a
// category that only ever existed as free text on a product had no chip, and a
// shop that imported its whole catalogue saw only the few categories it had
// typed itself. That reads as a cap on how many categories are allowed, which
// is what it was reported as.
//
// Deliberately after the products are inserted and deliberately unable to fail
// the import: by this point the shop's catalogue is in. A missing chip is a
// cosmetic loss the backfill migration or the next import will repair, whereas
// throwing here would report a completed import as a failure and invite a
// re-upload that rejects every row as a duplicate.
async function registerNames(shopId: string, created: NewProductInput[]): Promise<void> {
  if (created.length === 0) return;
  // Case-insensitively distinct, first spelling wins: `onConflict shop_id,name`
  // is case-SENSITIVE, so sending both "Serum" and "serum" would make two rows
  // and two chips for what the shop means as one category.
  const distinct = (values: (string | null | undefined)[]): string[] => {
    const byKey = new Map<string, string>();
    for (const value of values) {
      const name = value?.trim();
      if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
    }
    return [...byKey.values()];
  };

  await Promise.all([
    ...distinct(created.map((p) => p.category)).map((name) => createCategory(shopId, name)),
    ...distinct(created.map((p) => p.brand)).map((name) => createBrand(shopId, name)),
    ...distinct(created.flatMap((p) => p.tags)).map((name) => createTag(shopId, name)),
  ]).catch(() => {});
}
