import { supabase } from '@/lib/supabase';
import type { AudienceFilter, Campaign, CampaignRecipient, RecipientState } from '@/types/models';

function mapCampaignRow(row: any): Campaign {
  return {
    id: row.id,
    shopId: row.shop_id,
    promotionId: row.promotion_id ?? null,
    name: row.name,
    messageEn: row.message_en ?? null,
    messageSo: row.message_so ?? null,
    audience: row.audience,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
  };
}

function mapRecipientRow(row: any): CampaignRecipient {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    customerId: row.customer_id,
    state: row.state,
    openedAt: row.opened_at ?? null,
    sentAt: row.sent_at ?? null,
  };
}

export async function listCampaigns(shopId: string): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapCampaignRow);
}

export type NewCampaignInput = {
  promotionId: string | null;
  name: string;
  messageEn: string | null;
  messageSo: string | null;
  audience: AudienceFilter;
};

export async function createCampaign(shopId: string, input: NewCampaignInput): Promise<Campaign> {
  const { data, error } = await supabase
    .from('campaigns')
    .insert({
      shop_id: shopId,
      promotion_id: input.promotionId,
      name: input.name,
      message_en: input.messageEn,
      message_so: input.messageSo,
      audience: input.audience,
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapCampaignRow(data);
}

export type CampaignPatch = Partial<{
  promotionId: string | null;
  name: string;
  messageEn: string | null;
  messageSo: string | null;
  audience: AudienceFilter;
  status: Campaign['status'];
  startedAt: string | null;
}>;

export async function updateCampaign(id: string, patch: CampaignPatch): Promise<Campaign> {
  const { data, error } = await supabase
    .from('campaigns')
    .update({
      ...(patch.promotionId !== undefined && { promotion_id: patch.promotionId }),
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.messageEn !== undefined && { message_en: patch.messageEn }),
      ...(patch.messageSo !== undefined && { message_so: patch.messageSo }),
      ...(patch.audience !== undefined && { audience: patch.audience }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.startedAt !== undefined && { started_at: patch.startedAt }),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapCampaignRow(data);
}

export async function deleteCampaign(id: string): Promise<void> {
  const { error } = await supabase.from('campaigns').delete().eq('id', id);
  if (error) throw error;
}

export async function listRecipients(campaignId: string): Promise<CampaignRecipient[]> {
  const { data, error } = await supabase
    .from('campaign_recipients')
    .select('*')
    .eq('campaign_id', campaignId);
  if (error) throw error;
  return (data ?? []).map(mapRecipientRow);
}

// Adds the audience's customers who are not already queued, and returns how
// many were added.
//
// Called every time the queue is opened, not only when sending starts. That is
// what makes "fix a phone number and they join the queue" true rather than
// aspirational: the filter is re-evaluated, anyone newly matching is inserted,
// and the unique (campaign_id, customer_id) constraint makes running it
// repeatedly harmless.
//
// Removal is deliberately NOT symmetric. A customer who stops matching the
// filter mid-campaign keeps their row: deleting people from a queue the owner
// is halfway through would silently move the denominator they are working
// against.
export async function syncRecipients(campaignId: string, customerIds: string[]): Promise<number> {
  if (customerIds.length === 0) return 0;
  const { data, error } = await supabase
    .from('campaign_recipients')
    .upsert(
      customerIds.map((customerId) => ({ campaign_id: campaignId, customer_id: customerId })),
      { onConflict: 'campaign_id,customer_id', ignoreDuplicates: true }
    )
    .select('id');
  if (error) throw error;
  return data?.length ?? 0;
}

// Only state/openedAt/sentAt are ever written back — the migration grants
// UPDATE on exactly those columns (campaign_id/customer_id are the honest
// record of who was actually contacted, and there is no DELETE grant at all,
// so a recipient row is never removed once synced).
// 'now' rather than the device's clock, following markThreadRead in
// src/lib/support.ts, which stamps its own column-scoped grant the same way
// and for the same reason: these are shared tablets with poor time sync, and
// there is no trigger behind this column to correct a bad value.
//
// It matters more here than for a read receipt. `sent_at` is the origin of the
// only outcome number this feature reports -- "bought within 7 days of being
// messaged" is measured from it -- so a phone running fast or slow would skew
// that window silently, and nothing downstream could tell. 'now' is Postgres'
// own spelling of the transaction clock, so the server stamps it.
export async function setRecipientState(id: string, state: RecipientState): Promise<void> {
  const { error } = await supabase
    .from('campaign_recipients')
    .update({
      state,
      ...(state === 'opened' && { opened_at: 'now' }),
      ...(state === 'sent' && { sent_at: 'now' }),
    })
    .eq('id', id);
  if (error) throw error;
}
