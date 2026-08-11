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

// The bucket's own allowed_mime_types, restated (20260825000000). The bucket is
// the rule -- it binds an operator writing through a session the client code
// never ran -- and this copy exists so a refusal happens at the moment somebody
// picks the file, with a sentence, instead of after an upload that spends their
// data and comes back as a bare 415.
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/plain',
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
];

export type PendingAttachment = {
  uri: string;
  fileName: string;
  byteSize: number;
  contentType: string | null;
};

// What actually landed in the bucket, ready to be written down as a row. The
// row is a separate step on both sides -- the store inserts it directly, the
// console posts it to platform-admin so the audit log records what we sent --
// so the upload half stops here.
export type UploadedAttachment = {
  storagePath: string;
  fileName: string;
  byteSize: number;
  contentType: string | null;
};

// A name and WHY. "didn't attach" alone is what makes somebody pick the same
// unsupported file a second time.
export type MissedAttachment = { fileName: string; reason: string };

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
  // A null type is not "unknown, probably fine": uploadAttachment sends
  // application/octet-stream for it, which the bucket does not accept either,
  // so this is a refusal that was going to happen anyway -- here it happens
  // before the upload and says something a person can act on.
  if (!next.contentType || !ALLOWED_MIME_TYPES.includes(next.contentType)) {
    return {
      ok: false,
      message:
        'We cannot open that kind of file. Screenshots, photos, PDFs, plain text and short clips all work — a screenshot of it is usually enough.',
    };
  }
  if (next.byteSize > WARN_BYTES) {
    return { ok: true, warn: 'That is a big file — it may take a while to send on a slow connection.' };
  }
  return { ok: true, warn: null };
}

// The bucket refuses in its own words -- "The object exceeded the maximum
// allowed size", "mime type application/zip is not supported" -- and those
// reach the person as-is unless something turns them round. Both refusals are
// survivable and both have a different fix, so they are worth telling apart.
//
// Reads as a clause, not a sentence: it lands inside "X didn't attach (...)".
export function describeUploadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  if (lower.includes('exceeded the maximum allowed size') || lower.includes('too large') || lower.includes('413')) {
    return 'over 10 MB';
  }
  if (lower.includes('mime type') || lower.includes('not supported') || lower.includes('invalid_mime_type')) {
    return 'not a kind we can open';
  }
  return 'it did not go through';
}

// The first segment MUST be the shop id and the second MUST be the thread id:
// the storage policies (20260825000000, widened for operators in
// 20260825000700) read them with storage.foldername(name)[1] / [2], and the
// support_attachments table has a before-insert trigger that rejects a row
// whose storage_path doesn't match those same two segments. Any other shape is
// a 403 or a check violation, not a cosmetic difference. The timestamp keeps
// every write unique, because uploads use upsert:false and a collision fails
// the send.
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

// Every surface that can attach anything goes through here: the store's compose
// form, the store's reply box, the operator's reply panel and the operator's
// outbound composer. They differ in how the ROW gets written, not in how the
// file gets there, and four copies of the path/timestamp/one-try-per-file rules
// is four places for them to drift.
//
// Deliberately cannot throw. By the time this runs the message it belongs to
// has been sent, and a file that did not upload is a qualification on a message
// that arrived -- never grounds to tell somebody their words went nowhere.
export async function uploadAttachments(
  shopId: string,
  threadId: string,
  files: PendingAttachment[],
  startedAt: number = Date.now()
): Promise<{ uploaded: UploadedAttachment[]; missed: MissedAttachment[] }> {
  const uploaded: UploadedAttachment[] = [];
  const missed: MissedAttachment[] = [];
  for (const [index, file] of files.entries()) {
    // `startedAt + index` rather than a fresh clock read: the timestamp is only
    // there to keep paths unique, uploads use upsert:false, and two files of
    // the same name picked from different folders can finish inside the same
    // millisecond -- which would fail the second one.
    const storagePath = attachmentPath(shopId, threadId, file.fileName, startedAt + index);
    try {
      await uploadAttachment(storagePath, file);
      uploaded.push({
        storagePath,
        fileName: file.fileName,
        byteSize: file.byteSize,
        contentType: file.contentType,
      });
    } catch (error) {
      // One file failing says nothing about the next one.
      missed.push({ fileName: file.fileName, reason: describeUploadFailure(error) });
    }
  }
  return { uploaded, missed };
}

// The store's half: upload, then write the row from the member's own session.
// The insert policy is "attach to your own message" (20260825000000), so this
// only ever works for the person who wrote the message it hangs on.
//
// The operator's half is NOT here. Their rows go through platform-admin, which
// is the only write path for the console and the only thing that puts what we
// sent a store into the audit log.
export async function attachToMessage(
  shopId: string,
  threadId: string,
  messageId: string,
  files: PendingAttachment[]
): Promise<MissedAttachment[]> {
  if (files.length === 0) return [];
  const { uploaded, missed } = await uploadAttachments(shopId, threadId, files);
  for (const file of uploaded) {
    const { error } = await supabase.from('support_attachments').insert({
      message_id: messageId,
      storage_path: file.storagePath,
      file_name: file.fileName,
      byte_size: file.byteSize,
      content_type: file.contentType,
    });
    // An object with no row is a file nothing renders -- the same outcome as a
    // failed upload, so it is reported the same way rather than left to look
    // like a success.
    if (error) missed.push({ fileName: file.fileName, reason: describeUploadFailure(error) });
  }
  return missed;
}

// One sentence for the caveat that follows a partly-attached send. Says what to
// do, and says it differently now that every reply box on both sides has a
// picker -- until 20260825000700 the store could only attach on its FIRST
// message, so "attach it there" would have sent the one person who has just
// lost a file to a dead end.
export function missedAttachmentNote(missed: MissedAttachment[]): string | null {
  if (missed.length === 0) return null;
  if (missed.length === 1) {
    return `Sent — but ${missed[0].fileName} didn't attach (${missed[0].reason}). Reply on the conversation to attach it again.`;
  }
  // De-duplicated: five files refused for the same reason is one reason, and
  // "over 10 MB; over 10 MB; over 10 MB" reads as a stutter rather than a list.
  const reasons = [...new Set(missed.map((m) => m.reason))].join('; ');
  return `Sent — but ${missed.length} files didn't attach (${reasons}). Reply on the conversation to attach them again.`;
}

// The bucket is private, so reads need a signed URL rather than getPublicUrl.
// One hour is long enough to open an attachment and short enough that a
// copied link stops working before it can be passed around.
export async function signedUrlFor(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
  if (error) throw error;
  return data.signedUrl;
}
