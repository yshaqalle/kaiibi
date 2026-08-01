import type { ParsedCsv } from '@/lib/csv';
import type { ImportReport, RejectedRow } from '@/lib/import-shared';
import { listProducts } from '@/lib/products';
import { supabase } from '@/lib/supabase';
import { taxCentsFor } from '@/lib/tax';
import type { Shop } from '@/types/models';

export const SALES_TEMPLATE_COLUMNS: { header: string; required: boolean }[] = [
  { header: 'Sale Reference', required: true },
  { header: 'Date', required: false },
  { header: 'Customer Name', required: false },
  { header: 'Customer Phone', required: false },
  { header: 'Customer Email', required: false },
  { header: 'Payment Method', required: true },
  { header: 'Product SKU', required: false },
  { header: 'Product Name', required: false },
  { header: 'Quantity', required: true },
  { header: 'Discount', required: false },
];

// One row per line item -- rows sharing the same Sale Reference become one
// sale. Either Product SKU or Product Name identifies the item; Date/
// Customer/Payment Method only need to be filled on one row per reference
// (the first row's values are used for the whole group).
export const SALES_EXAMPLE_ROWS: Record<string, string>[] = [
  { 'Sale Reference': 'SALE-1001', Date: '2026-06-14', 'Customer Name': 'Amina Hassan', 'Customer Phone': '+252634000000', 'Customer Email': '', 'Payment Method': 'cash', 'Product SKU': 'TSHIRT-BLU-M', 'Product Name': '', Quantity: '2', Discount: '' },
  { 'Sale Reference': 'SALE-1001', Date: '2026-06-14', 'Customer Name': 'Amina Hassan', 'Customer Phone': '+252634000000', 'Customer Email': '', 'Payment Method': 'cash', 'Product SKU': '', 'Product Name': 'Wool Scarf', Quantity: '1', Discount: '1.00' },
];

const VALID_METHODS = new Set(['cash', 'zaad', 'edahab', 'other']);

function parseDollarsToCents(value: string | undefined): number {
  if (!value?.trim()) return 0;
  const n = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.max(Math.round(n * 100), 0) : 0;
}

function parseWholeNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

// Undefined/blank means "use today" (RPC default); a value that doesn't
// parse is a data problem worth rejecting rather than silently ignoring.
function parseDateOrInvalid(value: string | undefined): { iso: string | null } | null {
  const trimmed = value?.trim();
  if (!trimmed) return { iso: null };
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : { iso: d.toISOString() };
}

export type AcceptedSale = { saleReference: string; saleId: string; totalCents: number };

// Every line item must resolve to a real product and have enough stock, and
// stock must be decremented exactly like a normal checkout -- so this calls
// the same `complete_sale` RPC the POS uses (see migration
// 20260801232553_complete_sale_created_at_override.sql for its optional
// p_created_at) instead of inserting rows directly. A group that fails any
// check is rejected as a whole -- complete_sale raises an exception and
// Postgres rolls back that call's effects entirely, so nothing is partially
// applied. Groups run sequentially (not in parallel) so an already-committed
// group's stock decrement is visible to the next group's check.
export async function runSalesImport(shop: Shop, parsed: ParsedCsv): Promise<ImportReport<AcceptedSale>> {
  const products = await listProducts(shop.id);
  const bySku = new Map(products.filter((p) => p.sku).map((p) => [p.sku!.trim().toLowerCase(), p]));
  const byName = new Map(products.map((p) => [p.name.trim().toLowerCase(), p]));

  const groups = new Map<string, { row: number; data: Record<string, string> }[]>();
  const orderedRefs: string[] = [];
  parsed.rows.forEach((raw, i) => {
    const row = i + 2; // header occupies row 1 in the uploaded file
    const ref = raw['Sale Reference']?.trim() || `__missing_reference_row_${row}`;
    if (!groups.has(ref)) { groups.set(ref, []); orderedRefs.push(ref); }
    groups.get(ref)!.push({ row, data: raw });
  });

  const rejected: RejectedRow[] = [];
  const accepted: AcceptedSale[] = [];

  for (const ref of orderedRefs) {
    const rows = groups.get(ref)!;
    const rejectGroup = (reason: string) => { for (const r of rows) rejected.push({ row: r.row, reason, data: r.data }); };

    if (ref.startsWith('__missing_reference_row_')) { rejectGroup('Missing Sale Reference.'); continue; }

    const first = rows[0].data;
    const method = first['Payment Method']?.trim().toLowerCase();
    if (!method || !VALID_METHODS.has(method)) { rejectGroup(`Payment Method must be one of cash, zaad, edahab, other (got "${first['Payment Method'] ?? ''}").`); continue; }

    const date = parseDateOrInvalid(first['Date']);
    if (!date) { rejectGroup(`Invalid Date "${first['Date']}" — use YYYY-MM-DD.`); continue; }

    const items: { product_id: string; quantity: number; discount_cents: number }[] = [];
    let grossCents = 0;
    let failure: string | null = null;
    for (const r of rows) {
      const skuKey = r.data['Product SKU']?.trim().toLowerCase();
      const nameKey = r.data['Product Name']?.trim().toLowerCase();
      const product = (skuKey && bySku.get(skuKey)) || (nameKey && byName.get(nameKey));
      if (!product) { failure = `Product not found: ${r.data['Product SKU'] || r.data['Product Name'] || '(none given)'} (row ${r.row}).`; break; }

      const quantity = parseWholeNumber(r.data['Quantity']);
      if (quantity === null || quantity <= 0) { failure = `Quantity must be a positive whole number (row ${r.row}).`; break; }

      const discountCents = parseDollarsToCents(r.data['Discount']);
      const lineTotal = product.priceCents * quantity - discountCents;
      if (lineTotal < 0) { failure = `Discount exceeds line total for ${product.name} (row ${r.row}).`; break; }

      items.push({ product_id: product.id, quantity, discount_cents: discountCents });
      grossCents += lineTotal;
    }
    if (failure) { rejectGroup(failure); continue; }

    const taxCents = shop.taxEnabled ? taxCentsFor(grossCents, shop.taxRatePercent) : 0;
    const totalCents = grossCents + taxCents;
    if (totalCents <= 0) { rejectGroup('Sale total must be greater than zero.'); continue; }

    const { data, error } = await supabase.rpc('complete_sale', {
      p_shop_id: shop.id,
      p_items: items,
      p_payments: [{ method, amount_cents: totalCents }],
      p_customer_name: first['Customer Name']?.trim() || null,
      p_customer_phone: first['Customer Phone']?.trim() || null,
      p_customer_email: first['Customer Email']?.trim() || null,
      p_created_at: date.iso,
    });
    if (error) { rejectGroup(error.message); continue; }

    accepted.push({ saleReference: ref, saleId: data as string, totalCents });
  }

  return { accepted, rejected };
}
