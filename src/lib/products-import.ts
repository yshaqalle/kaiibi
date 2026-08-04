import type { ParsedCsv } from '@/lib/csv';
import type { ImportReport, RejectedRow } from '@/lib/import-shared';
import { createProducts, listProducts } from '@/lib/products';
import type { NewProductInput, Product } from '@/types/models';

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
export const PRODUCTS_EXAMPLE_ROW: Record<string, string> = {
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
};

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

// Rejects any row whose name or SKU collides with an existing product, or
// with an earlier row in the same file -- never auto-updates, per the
// confirmed "reject both, tell the user to update it in the app" rule.
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

  const headroom = options?.headroom ?? null;
  const rejected: RejectedRow[] = [];
  const toCreate: NewProductInput[] = [];
  const seenNames = new Set<string>();
  const seenSkus = new Set<string>();

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

    if (existingNames.has(nameKey) || (skuKey && existingSkus.has(skuKey))) {
      return reject(`A product named "${name}"${sku ? ` or with SKU "${sku}"` : ''} already exists — edit it in Inventory instead of importing.`);
    }
    if (seenNames.has(nameKey) || (skuKey && seenSkus.has(skuKey))) {
      return reject('Duplicate of an earlier row in this file.');
    }

    const priceCents = parseDollarsToCents(raw['Price']);
    if (priceCents === null || priceCents < 0) return reject('Price is required and must be a number (e.g. 12.99).');

    const stock = parseWholeNumber(raw['Stock']);
    if (stock === null || stock < 0) return reject('Stock is required and must be a whole number.');

    seenNames.add(nameKey);
    if (skuKey) seenSkus.add(skuKey);

    toCreate.push({
      name,
      description: null,
      sku,
      barcode: raw['Barcode']?.trim() || null,
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
  return { accepted, rejected };
}
