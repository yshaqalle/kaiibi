import { supabase } from '@/lib/supabase';

// Shared by anything that uploads into the `product-images` bucket (product
// photos, shop logos) — its RLS is keyed off the first path segment being
// the shop id (see migration 0002), not the kind of image, so one bucket
// serves both. `path` should not include an extension; it's derived from
// the source and appended here.
export async function uploadImage(path: string, localUri: string): Promise<string> {
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
  const fullPath = `${path}.${extension}`;

  const { error } = await supabase.storage.from('product-images').upload(fullPath, buffer, {
    contentType: blob.type || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
    upsert: false,
  });
  if (error) throw error;

  const { data } = supabase.storage.from('product-images').getPublicUrl(fullPath);
  return data.publicUrl;
}
