import { uploadImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import type { NewProductInput, Product } from '@/types/models';

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

export async function listProducts(shopId: string): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapProductRow);
}

export async function getLowStockProducts(shopId: string, defaultLowStockLevel = 5): Promise<Product[]> {
  const products = await listProducts(shopId);
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

export async function createProduct(shopId: string, input: NewProductInput): Promise<Product> {
  const { data, error } = await supabase
    .from('products')
    .insert({ shop_id: shopId, ...toRow(input) })
    .select('*')
    .single();
  if (error) throw error;
  return mapProductRow(data);
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

export async function updateProduct(id: string, input: Partial<NewProductInput>): Promise<Product> {
  const { data, error } = await supabase.from('products').update(toRow(input)).eq('id', id).select('*').single();
  if (error) throw error;
  return mapProductRow(data);
}

export async function deleteProduct(id: string): Promise<void> {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
}

export async function uploadProductImage(shopId: string, localUri: string): Promise<string> {
  return uploadImage(`${shopId}/${Date.now()}`, localUri);
}
