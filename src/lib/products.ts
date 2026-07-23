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

export async function getLowStockProducts(shopId: string): Promise<Product[]> {
  const products = await listProducts(shopId);
  return products.filter((p) => p.stock <= (p.reorderLevel ?? 5));
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
  const response = await fetch(localUri);
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();

  // Derive the extension from the URI's last path segment when it has one
  // (true for native `file://…/photo.jpg` URIs). expo-image-picker on web
  // instead returns a `blob:` object URL with no file extension at all, so
  // fall back to the Blob's own MIME type there.
  const lastSegment = localUri.split('/').pop() ?? '';
  const uriExtension = lastSegment.includes('.') ? lastSegment.split('.').pop() : undefined;
  const mimeExtension = blob.type ? blob.type.split('/').pop() : undefined;
  const extension = uriExtension || mimeExtension || 'jpg';
  const path = `${shopId}/${Date.now()}.${extension}`;

  const { error } = await supabase.storage.from('product-images').upload(path, buffer, {
    contentType: blob.type || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
    upsert: false,
  });
  if (error) throw error;

  const { data } = supabase.storage.from('product-images').getPublicUrl(path);
  return data.publicUrl;
}
