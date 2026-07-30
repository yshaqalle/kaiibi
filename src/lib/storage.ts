import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

// Shared by anything that uploads into the `product-images` bucket (product
// photos, shop logos) — its RLS is keyed off the first path segment being
// the shop id (see migration 0002), not the kind of image, so one bucket
// serves both. `path` should not include an extension; it's derived from
// the source and appended here.
export async function uploadImage(path: string, localUri: string): Promise<string> {
  // `fetch(localUri).blob()` looks cross-platform but isn't: on native,
  // that Blob is RN's own polyfill (react-native/Libraries/Blob/Blob.js),
  // which has no `arrayBuffer()` method — calling it throws "undefined is
  // not a function" on device while working fine on web's real Blob API.
  // expo-file-system's `File` reads bytes via native file APIs instead, so
  // it's used there -- but its web implementation is just a stub that warns
  // and no-ops (expo-file-system's `File`/`Directory` classes aren't
  // supported on web at all), so web has to go through fetch().blob() to
  // reach a real Blob.
  const body: Blob | Uint8Array = Platform.OS === 'web' ? await (await fetch(localUri)).blob() : await new File(localUri).bytes();
  const mimeType = body instanceof Blob ? body.type : undefined;

  // Derive the extension from the URI's last path segment when it has one
  // (true for native `file://…/photo.jpg` URIs). expo-image-picker on web
  // instead returns a `blob:` object URL with no file extension at all, so
  // fall back to the file's own MIME type there.
  const lastSegment = localUri.split('/').pop() ?? '';
  const uriExtension = lastSegment.includes('.') ? lastSegment.split('.').pop() : undefined;
  const mimeExtension = mimeType ? mimeType.split('/').pop() : undefined;
  const extension = uriExtension || mimeExtension || 'jpg';
  const fullPath = `${path}.${extension}`;

  const { error } = await supabase.storage.from('product-images').upload(fullPath, body, {
    contentType: mimeType || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
    upsert: false,
  });
  if (error) throw error;

  const { data } = supabase.storage.from('product-images').getPublicUrl(fullPath);
  return data.publicUrl;
}
