import { uploadImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import type { NewProductInput, Product, ProductLocationStock } from '@/types/models';

function mapProductRow(row: any): Product {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    description: row.description,
    sku: row.sku,
    barcode: row.barcode,
    brand: row.brand,
    category: row.category,
    tags: row.tags ?? [],
    supplierName: row.supplier_name,
    costCents: row.cost_cents,
    priceCents: row.price_cents,
    stock: row.stock,
    reorderLevel: row.reorder_level,
    shelfNumber: row.shelf_number,
    expiryDate: row.expiry_date,
    batchNumber: row.batch_number,
    imageUrl: row.image_url,
    isListedOnline: row.is_listed_online,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(input: Partial<NewProductInput>) {
  return {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.sku !== undefined && { sku: input.sku }),
    ...(input.barcode !== undefined && { barcode: input.barcode }),
    ...(input.brand !== undefined && { brand: input.brand }),
    ...(input.category !== undefined && { category: input.category }),
    ...(input.tags !== undefined && { tags: input.tags }),
    ...(input.supplierName !== undefined && { supplier_name: input.supplierName }),
    ...(input.costCents !== undefined && { cost_cents: input.costCents }),
    ...(input.priceCents !== undefined && { price_cents: input.priceCents }),
    ...(input.stock !== undefined && { stock: input.stock }),
    ...(input.reorderLevel !== undefined && { reorder_level: input.reorderLevel }),
    ...(input.shelfNumber !== undefined && { shelf_number: input.shelfNumber }),
    ...(input.expiryDate !== undefined && { expiry_date: input.expiryDate }),
    ...(input.batchNumber !== undefined && { batch_number: input.batchNumber }),
    ...(input.imageUrl !== undefined && { image_url: input.imageUrl }),
    ...(input.isListedOnline !== undefined && { is_listed_online: input.isListedOnline }),
  };
}

// `locationId` scopes `stock` (and `reorderLevel`/`shelfNumber`, where the
// branch overrides them) to one branch. Omitted returns the shop-wide rollup,
// which is what `products.stock` has always been and remains -- so every
// existing caller keeps its old meaning without being touched.
//
// The scoped read joins rather than filters: a product with no row at this
// branch must still appear, showing 0, or it would silently vanish from the
// branch's inventory list and could never be stocked there.
export async function listProducts(shopId: string, locationId?: string | null): Promise<Product[]> {
  // The per-store rows come back either way, so the inventory table can show
  // WHERE a product's stock sits even in the combined view. `stock` still means
  // what it always did — the shop-wide rollup when unscoped, this store's count
  // when scoped — so nothing that reads it needs to know about the breakdown.
  const { data, error } = await supabase
    .from('products')
    .select('*, product_location_stock(location_id, stock, reorder_level, shelf_number)')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((row: any) => {
    const entries = (row.product_location_stock ?? []) as any[];
    const locationStock = entries.map((entry) => ({ locationId: entry.location_id, stock: entry.stock }));
    const base = { ...mapProductRow(row), locationStock };
    if (!locationId) return base;
    const here = entries.find((entry) => entry.location_id === locationId);
    return {
      ...base,
      stock: here?.stock ?? 0,
      reorderLevel: here?.reorder_level ?? row.reorder_level,
      shelfNumber: here?.shelf_number ?? row.shelf_number,
    };
  });
}

// Per-branch counts for one product, for the inventory detail breakdown and
// the transfer picker.
export async function listStockByLocation(productId: string): Promise<ProductLocationStock[]> {
  const { data, error } = await supabase
    .from('product_location_stock')
    .select('*')
    .eq('product_id', productId);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    productId: row.product_id,
    locationId: row.location_id,
    stock: row.stock,
    reorderLevel: row.reorder_level,
    shelfNumber: row.shelf_number,
  }));
}

// The only supported way to change a count. `products.stock` is derived from
// these rows by trigger (migration 20260810000000) and a direct write to it is
// discarded, so an adjustment that doesn't go through here has no effect.
export async function setLocationStock(
  productId: string,
  locationId: string,
  stock: number,
  overrides?: { reorderLevel?: number | null; shelfNumber?: string | null }
): Promise<void> {
  const { error } = await supabase.from('product_location_stock').upsert(
    {
      product_id: productId,
      location_id: locationId,
      stock,
      ...(overrides?.reorderLevel !== undefined && { reorder_level: overrides.reorderLevel }),
      ...(overrides?.shelfNumber !== undefined && { shelf_number: overrides.shelfNumber }),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'product_id,location_id' }
  );
  if (error) throw error;
}

// Moves stock between branches atomically -- both sides in one transaction, with
// a recorded movement. Adjusting the two counts separately would leave the shop
// short if the second write failed, and no record of what moved.
export async function transferStock(
  shopId: string,
  fromLocationId: string,
  toLocationId: string,
  items: { productId: string; quantity: number }[],
  note?: string | null
): Promise<string> {
  const { data, error } = await supabase.rpc('transfer_stock', {
    p_shop_id: shopId,
    p_from_location_id: fromLocationId,
    p_to_location_id: toLocationId,
    p_items: items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as string;
}

// Evaluated against the scoped stock when a location is given: a branch that is
// out of an item needs reordering even if the other branch is overflowing --
// which is exactly what the shop-wide rollup would hide.
export async function getLowStockProducts(
  shopId: string,
  defaultLowStockLevel = 5,
  locationId?: string | null
): Promise<Product[]> {
  const products = await listProducts(shopId, locationId);
  return products.filter((p) => p.stock <= (p.reorderLevel ?? defaultLowStockLevel));
}

// A product is only ever considered "expiring soon" if it has its own
// `expiryDate` set — a shop turning on expiry tracking never flags products
// that were never given a date in the first place.
export function isExpiringSoon(expiryDate: string, leadDays: number): boolean {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + leadDays);
  return expiryDate <= cutoff.toISOString().slice(0, 10);
}

export async function getExpiringProducts(shopId: string, leadDays: number): Promise<Product[]> {
  const products = await listProducts(shopId);
  return products.filter((p) => p.expiryDate != null && isExpiringSoon(p.expiryDate, leadDays));
}

export async function getProduct(id: string): Promise<Product> {
  const { data, error } = await supabase.from('products').select('*').eq('id', id).single();
  if (error) throw error;
  return mapProductRow(data);
}

// With no `locationId`, opening stock lands at the shop's primary location --
// the database trigger does that, which is what keeps CSV import and any caller
// that predates locations working unchanged.
//
// With one, the product is inserted at zero and the opening stock is written to
// the named branch instead. Two writes rather than one, deliberately: letting
// the trigger place the units at the primary and then moving them would
// momentarily credit the wrong branch, and any failure between the two would
// leave them there.
export async function createProduct(shopId: string, input: NewProductInput, locationId?: string | null): Promise<Product> {
  const { data, error } = await supabase
    .from('products')
    .insert({ shop_id: shopId, ...toRow(input), ...(locationId ? { stock: 0 } : {}) })
    .select('*')
    .single();
  if (error) throw error;
  const product = mapProductRow(data);
  if (locationId && (input.stock ?? 0) > 0) {
    await setLocationStock(product.id, locationId, input.stock ?? 0);
    return { ...product, stock: input.stock ?? 0 };
  }
  return product;
}

// Bulk counterpart to createProduct -- used by CSV import (src/lib/products-import.ts)
// to insert every already-validated row in one round trip instead of one
// request per row.
export async function createProducts(shopId: string, inputs: NewProductInput[]): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products')
    .insert(inputs.map((input) => ({ shop_id: shopId, ...toRow(input) })))
    .select('*');
  if (error) throw error;
  return (data ?? []).map(mapProductRow);
}

// `products.stock` is derived by trigger, so a `stock` in `input` would be
// silently discarded by the database. Rather than let an edit form quietly do
// nothing, the stock is split out and written to `locationId` -- which is why
// every caller that can edit stock has to say which branch it means.
//
// Without a `locationId` the stock is dropped from the update and a warning is
// the caller's problem, not a silent partial save: the other fields still
// persist, which matches what the update did before locations existed for every
// field except this one.
export async function updateProduct(
  id: string,
  input: Partial<NewProductInput>,
  locationId?: string | null
): Promise<Product> {
  const { stock, ...rest } = input;
  if (stock !== undefined && locationId) {
    await setLocationStock(id, locationId, stock);
  }
  const { data, error } = await supabase.from('products').update(toRow(rest)).eq('id', id).select('*').single();
  if (error) throw error;
  const product = mapProductRow(data);
  return stock !== undefined && locationId ? { ...product, stock } : product;
}

export async function deleteProduct(id: string): Promise<void> {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
}

export async function uploadProductImage(shopId: string, localUri: string): Promise<string> {
  return uploadImage(`${shopId}/${Date.now()}`, localUri);
}
