import { supabase } from '@/lib/supabase';
import { needsAreaOther, type SupportCategory } from '@/lib/support-taxonomy';

// 'email' is READ-ONLY history. The compose sheet no longer offers it and no
// operator surface can act on it -- support_author_profiles() returns only
// (id, full_name, phone) -- but rows written before it was withdrawn still
// carry it, and support_threads.contact_preference still accepts it. Dropping
// the member here would make those rows unrepresentable for no gain.
export type ContactPreference = 'in_app' | 'whatsapp' | 'email';

// The same number as support_messages.body's length check (migration
// 20260825000000). Enforced twice on purpose: the column is the rule, since a
// member holds an insert grant on `body` and can send a request this file never
// composed; this copy exists only so the person gets a sentence instead of a
// constraint violation.
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
  // Who wrote it. Carried because a thread's messages are not all from the
  // person who opened it -- a colleague can reply on the same thread -- and the
  // operator's panel only knows the OPENER's name. Without this it would put
  // that name on a message somebody else wrote.
  authorUserId: string | null;
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
  // Measured untrimmed while the insert stores the trimmed string, so a body
  // that only fits once its trailing whitespace is gone is refused. Deliberate:
  // the message asks them to shorten something they are looking at, and
  // counting characters they cannot see would make it a lie in the other
  // direction. The gap is whitespace only, and never a rejected write.
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

// Exported so the ☰ badge (`unreadCount`, below) and the thread list's Unread
// pill compute the same thing from the same expression -- two copies of this
// predicate is how a pill and a badge quietly disagree.
export function isUnread(thread: SupportThread): boolean {
  return !thread.shopReadAt || Date.parse(thread.lastMessageAt) > Date.parse(thread.shopReadAt);
}

export function unreadCount(threads: SupportThread[]): number {
  return threads.filter(isUnread).length;
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
    authorUserId: row.author_user_id ?? null,
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

// One request, because the thread and its first message are one thing: two
// round trips can land the thread and lose the message, and what the store is
// left with then is a subject-only thread pinned to the top of their list that
// they cannot delete and we cannot answer. No author argument -- the RPC reads
// auth.uid() itself (migration 20260825000000).
export async function createThread(
  shopId: string,
  draft: SupportDraft,
  context: Record<string, string>
): Promise<SupportThread> {
  const validation = validateDraft(draft);
  if (!validation.ok) throw new Error(validation.message);

  const { data, error } = await supabase.rpc('open_support_thread', {
    p_shop_id: shopId,
    p_category: draft.category,
    p_subject: draft.subject.trim(),
    p_details: draft.details.trim(),
    p_area: draft.area,
    p_area_other: draft.areaOther.trim() || null,
    p_contact_preference: draft.contactPreference,
    p_client_context: context,
  });
  if (error) throw error;
  return toThread(data);
}

export async function postReply(threadId: string, body: string, userId: string): Promise<SupportMessage> {
  const { data, error } = await supabase
    .from('support_messages')
    .insert({ thread_id: threadId, author_kind: 'shop', author_user_id: userId, body: body.trim() })
    .select('*')
    .single();
  if (error) throw error;
  return {
    id: data.id,
    threadId,
    authorKind: 'shop',
    authorUserId: userId,
    body: data.body,
    createdAt: data.created_at,
    attachments: [],
  };
}

// The only column a store may update on a thread; the grant behind this is
// column-level for that reason (migration 20260825000000).
//
// The request carries no device time. These are shared tablets with poor time
// sync, and a clock running fast would stamp this thread as read into the
// future, so the operator's next reply arrives already-read and never raises
// the badge. A before-update trigger overwrites whatever arrives here with
// now(); 'now' is Postgres' own spelling of the transaction clock, so the
// column is server-stamped in the reading where the trigger is missing too.
export async function markThreadRead(threadId: string): Promise<void> {
  const { error } = await supabase
    .from('support_threads')
    .update({ shop_read_at: 'now' })
    .eq('id', threadId);
  if (error) throw error;
}
