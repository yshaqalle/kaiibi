import { supabase } from '@/lib/supabase';
import { needsAreaOther, type SupportCategory } from '@/lib/support-taxonomy';

export type ContactPreference = 'in_app' | 'whatsapp' | 'email';

// Matches the column's check constraint (migration 20260825000000). Trimming
// here and rejecting there means the same limit is enforced twice on purpose:
// the client message is kind, the column is the rule.
const DETAILS_MAX = 4000;

export type SupportDraft = {
  category: SupportCategory | null;
  area: string | null;
  areaOther: string;
  subject: string;
  details: string;
  contactPreference: ContactPreference;
};

export type SupportThread = {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  area: string | null;
  areaOther: string | null;
  status: 'open' | 'closed';
  openedBy: 'shop' | 'platform';
  contactPreference: ContactPreference;
  lastMessageAt: string;
  shopReadAt: string | null;
  createdAt: string;
};

export type SupportMessage = {
  id: string;
  threadId: string;
  authorKind: 'shop' | 'platform';
  body: string;
  createdAt: string;
  attachments: { id: string; fileName: string; storagePath: string; byteSize: number }[];
};

export type DraftValidation =
  | { ok: true }
  | { ok: false; field: 'category' | 'subject' | 'details' | 'areaOther'; message: string };

// Ordered top-to-bottom so the message lands under the first field the reader
// would fix, rather than under whichever check happened to run first.
export function validateDraft(draft: SupportDraft): DraftValidation {
  if (!draft.category) {
    return { ok: false, field: 'category', message: 'Pick what this is about.' };
  }
  if (needsAreaOther(draft.category, draft.area) && !draft.areaOther.trim()) {
    return { ok: false, field: 'areaOther', message: 'Tell us in a few words what this is about.' };
  }
  if (!draft.subject.trim()) {
    return { ok: false, field: 'subject', message: 'Give this a short subject so we can find it again.' };
  }
  if (!draft.details.trim()) {
    return { ok: false, field: 'details', message: 'Tell us what is going on — even a sentence helps.' };
  }
  if (draft.details.length > DETAILS_MAX) {
    return {
      ok: false,
      field: 'details',
      message: `That is longer than we can store — please trim it to ${DETAILS_MAX} characters.`,
    };
  }
  return { ok: true };
}

export type ClientContextInput = {
  appVersion: string | null;
  buildNumber: string | null;
  platform: string;
  isTablet: boolean;
  screen: string;
  locationName: string | null;
};

// Everything the person would otherwise be asked for and get wrong. Absent
// values are omitted rather than written as empty strings, so the operator's
// rail can tell "we don't know" from "it said nothing".
export function buildClientContext(input: ClientContextInput): Record<string, string> {
  const context: Record<string, string> = {
    platform: input.platform,
    deviceClass: input.isTablet ? 'tablet' : 'phone',
    screen: input.screen,
  };
  if (input.appVersion) context.appVersion = input.appVersion;
  if (input.buildNumber) context.buildNumber = input.buildNumber;
  if (input.locationName) context.locationName = input.locationName;
  return context;
}

// Re-exported rather than re-derived, the way platform.ts does it: this is the
// module the help screens import from, and a second idea of what a phone number
// looks like is a link that opens WhatsApp on a blank screen instead of
// erroring -- the worst failure available here. The shared helper knows that a
// Somaliland number written locally as 063 xxx xxxx needs its 0 swapped for
// 252, which a plain digit strip does not, and returns null rather than a
// best-effort URL when nothing dialable is left.
export { whatsappLink as whatsAppLink } from '@/lib/whatsapp';

export function unreadCount(threads: SupportThread[]): number {
  return threads.filter(
    (thread) => !thread.shopReadAt || Date.parse(thread.lastMessageAt) > Date.parse(thread.shopReadAt)
  ).length;
}

function toThread(row: any): SupportThread {
  return {
    id: row.id,
    reference: row.reference,
    subject: row.subject,
    category: row.category,
    area: row.area,
    areaOther: row.area_other,
    status: row.status,
    openedBy: row.opened_by,
    contactPreference: row.contact_preference,
    lastMessageAt: row.last_message_at,
    shopReadAt: row.shop_read_at,
    createdAt: row.created_at,
  };
}

// No shop filter: RLS already decides what this person can see, and adding a
// client-side one would quietly hide a thread the policy meant them to have.
export async function listMyThreads(): Promise<SupportThread[]> {
  const { data, error } = await supabase
    .from('support_threads')
    .select('*')
    .order('last_message_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toThread);
}

export async function listMessages(threadId: string): Promise<SupportMessage[]> {
  const { data, error } = await supabase
    .from('support_messages')
    .select('*, support_attachments(id, file_name, storage_path, byte_size)')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    threadId: row.thread_id,
    authorKind: row.author_kind,
    body: row.body,
    createdAt: row.created_at,
    attachments: (row.support_attachments ?? []).map((a: any) => ({
      id: a.id,
      fileName: a.file_name,
      storagePath: a.storage_path,
      byteSize: a.byte_size,
    })),
  }));
}

export async function createThread(
  shopId: string,
  userId: string,
  draft: SupportDraft,
  context: Record<string, string>
): Promise<SupportThread> {
  const validation = validateDraft(draft);
  if (!validation.ok) throw new Error(validation.message);

  const { data, error } = await supabase
    .from('support_threads')
    .insert({
      shop_id: shopId,
      opened_by: 'shop',
      author_user_id: userId,
      category: draft.category,
      area: draft.area,
      area_other: draft.areaOther.trim() || null,
      subject: draft.subject.trim(),
      contact_preference: draft.contactPreference,
      client_context: context,
    })
    .select('*')
    .single();
  if (error) throw error;

  const first = await postReply(data.id, draft.details.trim(), userId);

  // The reply fires support_messages_touch_thread, which moves last_message_at
  // and shop_read_at on the row we already hold -- so returning `data` as it
  // came back would hand the caller a thread that unreadCount() reads as unread
  // the instant its author wrote it. Both stamps are the trigger's now(), which
  // is the same transaction timestamp the message's created_at default took.
  return { ...toThread(data), lastMessageAt: first.createdAt, shopReadAt: first.createdAt };
}

export async function postReply(threadId: string, body: string, userId: string): Promise<SupportMessage> {
  const { data, error } = await supabase
    .from('support_messages')
    .insert({ thread_id: threadId, author_kind: 'shop', author_user_id: userId, body: body.trim() })
    .select('*')
    .single();
  if (error) throw error;
  return { id: data.id, threadId, authorKind: 'shop', body: data.body, createdAt: data.created_at, attachments: [] };
}

// The only column a store may update on a thread; the grant behind this is
// column-level for that reason (migration 20260825000000).
export async function markThreadRead(threadId: string): Promise<void> {
  const { error } = await supabase
    .from('support_threads')
    .update({ shop_read_at: new Date().toISOString() })
    .eq('id', threadId);
  if (error) throw error;
}
