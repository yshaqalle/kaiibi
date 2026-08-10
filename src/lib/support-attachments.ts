import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

// Deliberately NOT src/lib/storage.ts. That module is hardcoded to the public
// `product-images` bucket, and its own comment is explicit that its permission
// story is bucket-specific: an insert there requires inventory.edit,
// settings.access or staff.manage, which is exactly what a stuck cashier
// lacks. Support uploads go to a private bucket any shop member can write to.
const BUCKET = 'support-attachments';

export const MAX_ATTACHMENTS = 5;
export const MAX_BYTES = 10 * 1024 * 1024;
export const WARN_BYTES = 5 * 1024 * 1024;

export type PendingAttachment = {
  uri: string;
  fileName: string;
  byteSize: number;
  contentType: string | null;
};

export type AttachmentCheck = { ok: true; warn: string | null } | { ok: false; message: string };

export function checkAttachment(existing: PendingAttachment[], next: PendingAttachment): AttachmentCheck {
  if (existing.length >= MAX_ATTACHMENTS) {
    return {
      ok: false,
      message: `You can attach ${MAX_ATTACHMENTS} files to one message. Remove one to add another.`,
    };
  }
  if (next.byteSize > MAX_BYTES) {
    return {
      ok: false,
      message: 'That file is over 10 MB. Try a screenshot instead of a video, or send it in two parts.',
    };
  }
  if (next.byteSize > WARN_BYTES) {
    return { ok: true, warn: 'That is a big file — it may take a while to send on a slow connection.' };
  }
  return { ok: true, warn: null };
}

// The first segment MUST be the shop id and the second MUST be the thread id:
// the storage policies (20260825000000_support_threads.sql) read them with
// storage.foldername(name)[1] / [2], and the support_attachments table has a
// before-insert trigger that rejects a row whose storage_path doesn't match
// those same two segments. Any other shape is a 403 or a check violation, not
// a cosmetic difference. The timestamp keeps every write unique, because
// uploads use upsert:false and a collision fails the send.
export function attachmentPath(shopId: string, threadId: string, fileName: string, now: number): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '-').slice(-60);
  return `${shopId}/${threadId}/${now}-${safe}`;
}

export async function uploadAttachment(path: string, file: PendingAttachment): Promise<void> {
  // Same platform split as src/lib/storage.ts, and for the same reason: on
  // native, `fetch(uri).blob()` returns React Native's Blob polyfill, which
  // has no arrayBuffer(); on web, expo-file-system's File class is a no-op
  // stub. Neither works on both.
  const body: Blob | Uint8Array =
    Platform.OS === 'web' ? await (await fetch(file.uri)).blob() : await new File(file.uri).bytes();

  const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
    contentType: file.contentType ?? 'application/octet-stream',
    upsert: false,
  });
  if (error) throw error;
}

// The bucket is private, so reads need a signed URL rather than getPublicUrl.
// One hour is long enough to open an attachment and short enough that a
// copied link stops working before it can be passed around.
export async function signedUrlFor(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
  if (error) throw error;
  return data.signedUrl;
}
