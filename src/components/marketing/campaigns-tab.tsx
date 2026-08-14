import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useDetailSelection, useHeaderActions } from '@/components/accounting/use-header-actions';
import { Badge, type BadgeTone } from '@/components/badge';
import { Card } from '@/components/card';
import { CampaignComposer } from '@/components/marketing/campaign-composer';
import { type PromotionsTabProps } from '@/components/marketing/promotions-tab';
import { SendQueue } from '@/components/marketing/send-queue';
import { StatTile } from '@/components/stat-tile';
import { TwoPaneListDetail } from '@/components/two-pane-list-detail';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { GlanceStrip } from '@/components/ui/glance-strip';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { audienceSummary, isReachable, matchesAudience, type AudienceFilter } from '@/lib/campaign-audience';
import { fillMessage, type MessageValues } from '@/lib/campaign-message';
import { boughtWithin, countRecipients, reachableRecipientCount, recipientsProcessed } from '@/lib/campaign-metrics';
import { deleteCampaign, listCampaigns, listRecipients } from '@/lib/campaigns';
import { confirmDestructive } from '@/lib/confirm';
import { CUSTOMER_SEGMENT_LABELS } from '@/lib/customer-segments';
import { getCustomersStatsBatch, listCustomers, type CustomerStats } from '@/lib/customers';
import { promotionLiveIssue } from '@/lib/discounts';
import { instantToEndDateInput } from '@/lib/promotion-dates';
import { discountLabel, getPromotion, listPromotions, scopeLabel } from '@/lib/promotions';
import { listSalesInRange } from '@/lib/sales';
import type { Campaign, CampaignRecipient, Customer, Promotion, Sale } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet. Matches
// promotions-tab.tsx: this is a bento screen (see two-pane-list-detail.tsx).
const theme = Colors.light;

// Supabase rpc()/query errors are plain {code, details, hint, message}
// objects, never instanceof Error -- same fix as promotions-tab.tsx's
// extractErrorMessage, duplicated here rather than shared (poster-sheet.tsx
// does the same thing for the same reason: it's three lines, and a shared
// util file isn't worth the indirection).
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

// How many sales to look at when deciding "bought within 7 days of being
// messaged". There is no lean, purpose-built query for "every sale's
// customer_id and date" (getCustomersStatsBatch in customers.ts is close, but
// collapses each customer down to a single lastOrderAt, which would silently
// miss an earlier purchase that fell inside the window when a later one
// outside it overwrote the date).
//
// A plain "most recent N, shop-wide" used to bound this (see git history) and
// was wrong: a busy shop burns through a few hundred sales a week, so a
// campaign reviewed a month later had its whole 7-day window pushed outside
// the fetched slice, and the tile quietly under-counted with nothing on
// screen to say so. `listSalesInRange` bounds by DATE instead -- from the
// earliest `sentAt` of any 'sent' recipient across the campaigns just loaded
// (boughtWithin only ever looks at 'sent' recipients, so nothing before that
// can matter) through now. That window is normally days to a few months
// wide, not "the shop's whole history", so 10,000 is a backstop against a
// truncation this bound is not supposed to produce, not the mechanism that
// limits the query -- reaching it would take roughly a year of that "busy
// shop" pace inside a window this tight.
const SALES_WINDOW_LIMIT = 10_000;

// The earliest a purchase could still count toward ANY currently-loaded
// campaign's "bought within 7 days" tile. Recipients not yet fetched simply
// aren't considered here -- reload() calls this only after listRecipients has
// come back for every campaign in `campaignList`.
function earliestSentAt(recipientsByCampaign: ReadonlyMap<string, readonly CampaignRecipient[]>): Date | null {
  let earliest: number | null = null;
  for (const recipients of recipientsByCampaign.values()) {
    for (const recipient of recipients) {
      if (recipient.state !== 'sent' || !recipient.sentAt) continue;
      const at = Date.parse(recipient.sentAt);
      if (earliest === null || at < earliest) earliest = at;
    }
  }
  return earliest === null ? null : new Date(earliest);
}

// "VIP + Regular", "No purchase in 60 days", "Everyone" -- the same words for
// every place a campaign's audience is summarised (list row, detail header,
// the Audience tile's own hint), so they can never read as three different
// audiences.
function audienceWords(filter: AudienceFilter): string {
  const parts: string[] = [...filter.segments.map((s) => CUSTOMER_SEGMENT_LABELS[s]), ...filter.tags];
  if (filter.inactiveDays !== null) parts.push(`No purchase in ${filter.inactiveDays} days`);
  return parts.length > 0 ? parts.join(' + ') : 'Everyone';
}

// "20% off everything" / "20% off everything by Nike" / "20% off Shoes" -- the
// {offer} token's filler for the message preview. Not exported: this is
// wording for a live preview, not a stored value, and the composer (Task 9)
// is free to let an owner write its own.
function offerWords(promotion: Promotion | null): string {
  if (!promotion) return 'something special';
  const target =
    promotion.scope === 'store'
      ? 'everything'
      : promotion.scope === 'brand'
        ? `everything by ${promotion.scopeValue ?? 'this brand'}`
        : (promotion.scopeValue ?? 'select items');
  return `${discountLabel(promotion)} ${target}`;
}

// The promotion's end date as the owner actually reads it -- `endsAt` is
// stored EXCLUSIVE (see promotion-dates.ts), so this un-shifts it back to the
// inclusive last day and hands back a local-time Date rather than a string,
// for both the "Ends" row and the {ends} message token (as a weekday name).
function inclusiveEndDate(promotion: Promotion): Date | null {
  if (!promotion.endsAt) return null;
  const [year, month, day] = instantToEndDateInput(promotion.endsAt).split('-').map(Number);
  return new Date(year, month - 1, day);
}

// `reachable` must be sourced from this campaign's own recipient rows (see
// reachableRecipientCount), never from re-evaluating the audience filter
// live -- a live re-eval shrinks the moment someone the campaign already
// reached stops matching (they came back and bought, in a win-back
// campaign), which reads as "Sending 10 of 6" once `processed` overtakes it.
// Every caller below sources it the same way, so this label can never
// disagree with the tiles or the button next to it.
function statusChipFor(
  campaign: Campaign,
  recipients: readonly CampaignRecipient[],
  reachable: number
): { label: string; tone: BadgeTone } {
  if (campaign.status === 'draft') return { label: 'Draft', tone: 'default' };
  if (campaign.status === 'done') return { label: 'Done', tone: 'success' };
  return { label: `Sending ${recipientsProcessed(recipients)} of ${reachable}`, tone: 'warning' };
}

// Consumes `setCampaignsActions`/`setCampaignsDetailSelected` from
// marketing-tab.tsx -- the same prop shape PromotionsTab takes, since both
// are interchangeable sections inside MarketingTab.
export function CampaignsTab({ compact, setHeaderActions, setDetailSelected }: PromotionsTabProps) {
  const { shop, activeLocation } = useAuth();
  const router = useRouter();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerStats, setCustomerStats] = useState<Map<string, CustomerStats>>(new Map());
  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [recipientsByCampaign, setRecipientsByCampaign] = useState<Map<string, CampaignRecipient[]>>(new Map());
  // Tracks the FIRST fetch, not every fetch -- see the identical comment on
  // PromotionsTab/CustomersTab. Keeps rows mounted across a reload so the
  // list doesn't collapse and lose scroll position.
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the send queue is open for `selected` -- a flag rather than
  // holding the campaign itself, so it always tracks whatever `selected`
  // currently resolves to (including a fresh recipient count after reload()).
  // Which campaign the queue is open FOR, not a bare boolean.
  //
  // A reload can drop the selected campaign out from under an open queue
  // (deleted, or no longer in this location's list). SendQueue is gated on
  // `selected`, so it unmounts right then without its onClose ever running --
  // and a boolean would stay stuck true, springing the queue back open for a
  // completely different campaign nobody asked to send. Holding the id instead
  // means the queue is open only while the campaign it was opened for is still
  // the selected one, which is a fact rather than a flag to keep in sync. It
  // needs no effect to correct it, which is also why there is none.
  const [sendQueueForId, setSendQueueForId] = useState<string | null>(null);
  // Whether the composer (Task 9) is open. A bare boolean is enough here,
  // unlike sendQueueForId above -- the composer isn't opened FOR an existing
  // campaign, so there is no id for a reload to drop out from under it.
  const [composerOpen, setComposerOpen] = useState(false);

  useDetailSelection(setDetailSelected, selectedId !== null);
  useHeaderActions(
    setHeaderActions,
    <Pressable onPress={() => setComposerOpen(true)} accessibilityRole="button" style={[styles.actionButton, styles.actionButtonSolid]}>
      <Text style={[styles.actionButtonText, styles.actionButtonTextSolid]}>+ New campaign</Text>
    </Pressable>,
    []
  );

  const reload = useCallback(async () => {
    if (!shop) return;
    setError(null);
    try {
      const [campaignList, promotionList, customerList, stats] = await Promise.all([
        listCampaigns(shop.id),
        listPromotions(shop.id),
        listCustomers(shop.id),
        getCustomersStatsBatch(shop.id),
      ]);
      setCampaigns(campaignList);
      setPromotions(promotionList);
      setCustomers(customerList);
      setCustomerStats(stats);
      // One request per campaign -- there is no batched "recipients for every
      // campaign" query (listRecipients only takes one campaignId), same
      // limitation people.tsx used to have for per-customer stats before
      // getCustomersStatsBatch existed. Bounded by how many campaigns a shop
      // has, which runs to dozens, not hundreds -- unlike customers.
      const recipientEntries = await Promise.all(
        campaignList.map(async (campaign) => [campaign.id, await listRecipients(campaign.id)] as const)
      );
      const recipientsMap = new Map(recipientEntries);
      setRecipientsByCampaign(recipientsMap);
      // Bounded by what THESE recipients actually need (see SALES_WINDOW_LIMIT
      // above) -- so this has to wait for the fetch just above rather than
      // joining the Promise.all it used to sit in.
      const since = earliestSentAt(recipientsMap);
      const sales = since ? await listSalesInRange(shop.id, since, undefined, SALES_WINDOW_LIMIT) : [];
      setRecentSales(sales);
    } catch (err) {
      setError(extractErrorMessage(err, 'Something went wrong.'));
    } finally {
      setLoaded(true);
    }
  }, [shop]);

  useEffect(() => {
    reload();
  }, [reload]);
  useRefreshOnFocus(reload);
  const pullToRefresh = usePullToRefresh(reload);

  const lastPurchaseByCustomer = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, stat] of customerStats) if (stat.lastOrderAt) map.set(id, stat.lastOrderAt);
    return map;
  }, [customerStats]);

  // What reachableRecipientCount/hasRecipientsLeftToActOn need to answer "is
  // THIS row's customer reachable" without re-deriving it from the audience
  // filter -- same map send-queue.tsx builds for the same reason.
  const customersById = useMemo(() => new Map(customers.map((c) => [c.id, c] as const)), [customers]);

  // The chip/tile/button denominator for a campaign that has started sending:
  // its own recipient ROWS, not a live re-evaluation of who currently matches
  // its filter (see reachableRecipientCount's own comment for why that drifts
  // mid-campaign). A campaign with no rows yet -- a draft nobody has opened
  // the queue for -- has nothing to source from yet, so it falls back to the
  // live filter purely as a size preview, same number the composer shows
  // before a campaign exists at all.
  function reachableFor(campaign: Campaign, recipients: readonly CampaignRecipient[]): number {
    return recipients.length > 0
      ? reachableRecipientCount(recipients, customersById)
      : audienceSummary(customers, campaign.audience, lastPurchaseByCustomer).reachable;
  }

  const salesByCustomer = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const sale of recentSales) {
      if (!sale.customerId) continue;
      const existing = map.get(sale.customerId);
      if (existing) existing.push(sale.createdAt);
      else map.set(sale.customerId, [sale.createdAt]);
    }
    return map;
  }, [recentSales]);

  const statusCounts = useMemo(() => {
    const counts = { draft: 0, sending: 0, done: 0 };
    for (const campaign of campaigns) counts[campaign.status]++;
    return counts;
  }, [campaigns]);

  const selected = campaigns.find((c) => c.id === selectedId) ?? null;
  // `promotions` (listPromotions) leaves archived rows out on purpose -- every
  // OTHER screen that lists promotions wants an archived one gone. A campaign
  // built on one is the one place that isn't true: `promotion_id` is `on
  // delete set null` specifically so a finished campaign can still name what
  // it offered, and dropping that here would have it claim "no discount" for
  // exactly the campaigns most worth reviewing. So a promotionId absent from
  // the active list is looked up directly, archived or not, and cached by id
  // rather than re-fetched on every render.
  const [archivedPromotion, setArchivedPromotion] = useState<{ id: string; promotion: Promotion | null } | null>(null);
  useEffect(() => {
    const id = selected?.promotionId;
    if (!id) return;
    if (promotions.some((p) => p.id === id)) return;
    if (archivedPromotion?.id === id) return;
    let cancelled = false;
    getPromotion(id)
      .then((promotion) => {
        if (!cancelled) setArchivedPromotion({ id, promotion });
      })
      .catch(() => {
        if (!cancelled) setArchivedPromotion({ id, promotion: null });
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.promotionId, promotions, archivedPromotion]);
  const selectedPromotion = selected?.promotionId
    ? (promotions.find((p) => p.id === selected.promotionId) ??
      (archivedPromotion?.id === selected.promotionId ? archivedPromotion.promotion : null))
    : null;
  const selectedAudience = useMemo(
    () => (selected ? audienceSummary(customers, selected.audience, lastPurchaseByCustomer) : null),
    [selected, customers, lastPurchaseByCustomer]
  );
  const selectedRecipients = selected ? (recipientsByCampaign.get(selected.id) ?? []) : [];
  // The recipient a real chat would open for -- reachable preferred, so the
  // preview shows a message that could actually be sent, not one for someone
  // the send queue would skip straight past.
  const sampleCustomer = useMemo(() => {
    if (!selected) return null;
    const matched = customers.filter((c) => matchesAudience(c, selected.audience, lastPurchaseByCustomer.get(c.id) ?? null));
    return matched.find(isReachable) ?? matched[0] ?? null;
  }, [selected, customers, lastPurchaseByCustomer]);
  // Whether a top-up (the sync SendQueue itself runs the moment it's opened,
  // see send-queue.tsx) could still bring a NEW customer into a 'done'
  // campaign's queue -- one who now matches the audience filter but has no
  // recipient row yet. Paired with `unreachable > 0` inside
  // CampaignDetailPane (an already-queued customer whose number might just
  // have been fixed), this is what decides whether "Continue sending" stays
  // reachable after 'done' -- see send-queue.tsx's status-effect comment for
  // the other half: what actually flips status back to 'sending' once the
  // owner acts on it.
  const selectedNewMatchAvailable = useMemo(() => {
    if (!selected) return false;
    const existingIds = new Set((recipientsByCampaign.get(selected.id) ?? []).map((r) => r.customerId));
    return customers.some(
      (c) => !existingIds.has(c.id) && matchesAudience(c, selected.audience, lastPurchaseByCustomer.get(c.id) ?? null)
    );
  }, [selected, customers, lastPurchaseByCustomer, recipientsByCampaign]);

  const list = (
    <>
      {!loaded ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : campaigns.length === 0 ? (
        <Text style={styles.empty}>No campaigns yet — use + New campaign above to tell customers about an offer over WhatsApp.</Text>
      ) : (
        <Card variant="bento" style={styles.list}>
          {campaigns.map((campaign) => {
            const recipients = recipientsByCampaign.get(campaign.id) ?? [];
            const reachable = reachableFor(campaign, recipients);
            const chip = statusChipFor(campaign, recipients, reachable);
            return (
              <Pressable
                key={campaign.id}
                onPress={() => setSelectedId(campaign.id)}
                style={[styles.row, campaign.id === selectedId && styles.rowSelected]}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowName}>{campaign.name}</Text>
                  <Text style={styles.rowSub}>
                    {audienceWords(campaign.audience)} · {reachable} reachable · made {new Date(campaign.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <Badge variant="bento" label={chip.label} tone={chip.tone} />
              </Pressable>
            );
          })}
        </Card>
      )}
    </>
  );

  // The composer has no "open an existing campaign" mode (Task 9), so a
  // campaign saved with nothing sendable -- no message, no recipients, an
  // offer that expired mid-write -- used to be a permanent row nobody could
  // fix or remove. `deleteCampaign` cascades its recipients (already in the
  // schema, see campaigns.ts), so this is the actual way out, not just a
  // list-row removal.
  const handleDeleteCampaign = () => {
    if (!selected) return;
    const campaignId = selected.id;
    confirmDestructive(
      'Delete this campaign?',
      'This removes it and every recipient row ever queued for it. There is no undo.',
      'Delete campaign',
      async () => {
        try {
          await deleteCampaign(campaignId);
          setSelectedId(null);
          await reload();
        } catch (err) {
          setError(extractErrorMessage(err, 'Could not delete this campaign.'));
        }
      }
    );
  };

  const detail =
    selected && selectedAudience ? (
      <CampaignDetailPane
        campaign={selected}
        promotion={selectedPromotion}
        liveAudience={selectedAudience}
        customersById={customersById}
        recipients={selectedRecipients}
        salesByCustomer={salesByCustomer}
        sampleCustomer={sampleCustomer}
        shopName={shop?.name ?? ''}
        branchName={activeLocation?.name ?? ''}
        canTopUpWhenDone={selectedNewMatchAvailable}
        onReviewUnreachable={() => router.push({ pathname: '/people', params: { tab: 'customers' } })}
        onContinueSending={() => setSendQueueForId(selected?.id ?? null)}
        onDelete={handleDeleteCampaign}
      />
    ) : (
      <BentoCard style={styles.emptyDetail}>
        <Text style={styles.empty}>Select a campaign to see its details.</Text>
      </BentoCard>
    );

  return (
    <View style={{ flex: 1 }}>
      {error && <Text style={styles.errorText}>{error}</Text>}

      <GlanceStrip style={styles.strip}>
        <StatTile variant="bento" density="dense" value={String(campaigns.length)} label="Campaigns" hint="every one this shop has made" />
        <StatTile variant="bento" density="dense" value={String(statusCounts.draft)} label="Draft" hint="not started yet" />
        <StatTile variant="bento" density="dense" value={String(statusCounts.sending)} label="Sending" hint="queue in progress" />
        <StatTile variant="bento" density="dense" value={String(statusCounts.done)} label="Done" hint="worked through" />
      </GlanceStrip>

      <TwoPaneListDetail
        listRefreshControl={pullToRefresh}
        compact={compact}
        list={list}
        detail={detail}
        detailOpen={selected !== null}
        onCloseDetail={() => setSelectedId(null)}
        detailTitle="Campaign"
      />

      {selected && sendQueueForId === selected.id && (
        <SendQueue
          campaign={selected}
          promotion={selectedPromotion}
          customers={customers}
          lastPurchaseByCustomer={lastPurchaseByCustomer}
          onClose={() => {
            setSendQueueForId(null);
            // The queue just wrote recipient states (and possibly synced new
            // rows) straight to the server -- reload() is what pulls those
            // changes back into the stat tiles and status chip behind it,
            // same as every other mutation on this screen refreshing via the
            // shared reload() rather than patching local state ad hoc.
            reload();
          }}
        />
      )}

      {composerOpen && (
        <CampaignComposer
          promotions={promotions}
          customers={customers}
          lastPurchaseByCustomer={lastPurchaseByCustomer}
          onClose={() => setComposerOpen(false)}
          onCreated={(campaign, startSending) => {
            setComposerOpen(false);
            setSelectedId(campaign.id);
            // Opens straight into the queue for "Start sending" -- the four
            // steps exist so the queue can take over, not so the owner has to
            // find the campaign again to begin. Left closed for a draft: the
            // campaign is created, but nothing has started.
            if (startSending) setSendQueueForId(campaign.id);
            // The composer wrote straight to the server (createCampaign,
            // possibly updateCampaign) -- reload() is what pulls the new row
            // (and its recipients, once the queue syncs them) back into this
            // screen's own state, same as every other mutation here.
            reload();
          }}
        />
      )}
    </View>
  );
}

function CampaignDetailPane({
  campaign,
  promotion,
  liveAudience,
  customersById,
  recipients,
  salesByCustomer,
  sampleCustomer,
  shopName,
  branchName,
  canTopUpWhenDone,
  onReviewUnreachable,
  onContinueSending,
  onDelete,
}: {
  campaign: Campaign;
  promotion: Promotion | null;
  // The audience filter re-evaluated live -- used ONLY as a size preview for
  // a draft that has no recipient rows yet (nobody has opened its queue, so
  // there is nothing durable to source from). The moment `recipients` is
  // non-empty, every figure below is sourced from those rows instead -- see
  // the comment on `matched`/`reachable` just below.
  liveAudience: { matched: number; reachable: number; unreachable: number };
  customersById: ReadonlyMap<string, Customer>;
  recipients: readonly CampaignRecipient[];
  salesByCustomer: ReadonlyMap<string, readonly string[]>;
  sampleCustomer: Customer | null;
  shopName: string;
  branchName: string;
  // Whether a customer who has NO recipient row yet now matches this
  // campaign's audience filter -- see the identical-purpose comment on
  // `selectedNewMatchAvailable` in CampaignsTab. Combined with `unreachable`
  // (computed below, from the campaign's own rows) to decide whether 'done'
  // still needs a way back in.
  canTopUpWhenDone: boolean;
  onReviewUnreachable: () => void;
  onContinueSending: () => void;
  onDelete: () => void;
}) {
  const counts = countRecipients(recipients);
  const bought = boughtWithin(recipients, salesByCustomer, 7);
  // A mount-time snapshot, not a live clock -- same tradeoff
  // campaign-composer.tsx's own `now` makes (see its comment), and for the
  // same reason: calling Date.now() straight in a render body is impure
  // (react-hooks/purity) and this button doesn't itself write anything, it
  // only opens send-queue.tsx's sheet -- which re-checks with the ACTUAL
  // clock right before the one action that does write (handleOpenWhatsApp).
  // This is what covers the common case CRITICAL 1 is about (a campaign
  // opened days after its offer ended); the sheet's own fresh check is what
  // covers a promotion dying in the seconds this pane happens to be open.
  const [now] = useState(() => Date.now());
  // Duplicated rather than shared as a prop because this pane also has to
  // gate the BUTTON that opens that sheet, not just the sheet's own send
  // action. `promotion === null` is deliberately not an issue -- see the
  // identical comment in send-queue.tsx.
  const promotionIssue = promotion ? promotionLiveIssue(promotion, now) : null;
  const endDate = promotion ? inclusiveEndDate(promotion) : null;
  const messageTemplate = campaign.messageEn ?? campaign.messageSo ?? null;
  const messageValues: MessageValues = {
    name: sampleCustomer?.firstName ?? 'there',
    shop: shopName,
    offer: offerWords(promotion),
    ends: endDate ? endDate.toLocaleDateString(undefined, { weekday: 'long' }) : '',
    branch: branchName,
  };
  const filledMessage = messageTemplate ? fillMessage(messageTemplate, messageValues) : null;
  // The rows this campaign actually materialised are the source of truth the
  // moment there are any -- see reachableRecipientCount's own comment for why
  // re-deriving this from the live filter drifts mid-campaign (a win-back
  // recipient who comes back and buys stops matching the filter without
  // having stopped being a real row this campaign already reached). Falls
  // back to the live filter only pre-send, when there is nothing to source
  // from yet.
  const hasRows = recipients.length > 0;
  const matched = hasRows ? recipients.length : liveAudience.matched;
  const reachable = hasRows ? reachableRecipientCount(recipients, customersById) : liveAudience.reachable;
  const unreachable = matched - reachable;
  // Everyone the queue has already worked through, of the reachable total --
  // what's left is the reachable count minus that, never below zero (a fresh
  // top-up can raise `reachable` past what a stale recipient count expects).
  const processed = recipientsProcessed(recipients);
  const left = Math.max(0, reachable - processed);
  const chip = statusChipFor(campaign, recipients, reachable);
  // CRITICAL: 'done' must not be a one-way door. hasRecipientsLeftToActOn
  // (send-queue.tsx's status effect) deliberately ignores 'waiting' rows
  // whose customer isn't reachable right now -- which means 'done' can be
  // written while a phone-less recipient still sits in the queue. A top-up
  // could still bring them back in one of two ways: their number gets fixed
  // (they're already a row, counted in `unreachable` above), or a customer
  // who didn't match the audience before now does (`canTopUpWhenDone`, a
  // customer with no row yet). Either one means "Continue sending" must stay
  // reachable even though the chip says Done -- otherwise the caveat below
  // ("fix a number and they join the queue automatically") is a promise this
  // screen can't keep.
  const canReopenDone = campaign.status === 'done' && (unreachable > 0 || canTopUpWhenDone);
  const continueLabel = campaign.status === 'done' ? 'Check for new recipients' : `Continue sending · ${left} left`;

  return (
    <View style={styles.detailStack}>
      <BentoCard>
        <View style={styles.detHeadRow}>
          <View style={styles.detIdent}>
            <Text style={styles.detName}>{campaign.name}</Text>
            <Badge variant="bento" label={chip.label} tone={chip.tone} />
          </View>
          <Pressable onPress={onDelete} accessibilityRole="button" style={styles.deleteBtn}>
            <Text style={styles.deleteBtnText}>Delete</Text>
          </Pressable>
        </View>
        {/* Two campaigns off the same offer share campaignNameFor's wording
            verbatim, and neither the row above nor this pane ever showed
            `createdAt` before -- `startedAt` is the only date a draft never
            has. This is the tell: "the one I made this morning." */}
        <Text style={styles.detMeta}>
          {audienceWords(campaign.audience)} · made {new Date(campaign.createdAt).toLocaleDateString()}
          {campaign.startedAt ? ` · started ${new Date(campaign.startedAt).toLocaleDateString()}` : ''}
        </Text>

        {campaign.status === 'done' && !canReopenDone ? (
          <Text style={styles.doneNote}>Done — every reachable customer was worked through.</Text>
        ) : promotionIssue ? (
          <>
            <Pressable disabled accessibilityRole="button" accessibilityState={{ disabled: true }} style={[styles.continueBtn, styles.continueBtnOff]}>
              <Text style={styles.continueBtnText}>{continueLabel}</Text>
            </Pressable>
            <Caveat tone="wrong">{`${promotionIssue} This campaign can no longer send until it's rebuilt with a different offer.`}</Caveat>
          </>
        ) : (
          <Pressable onPress={onContinueSending} accessibilityRole="button" style={styles.continueBtn}>
            <Text style={styles.continueBtnText}>{continueLabel}</Text>
          </Pressable>
        )}

        <View style={styles.tilesRow}>
          <StatTile variant="bento" value={String(matched)} label="Audience" hint={audienceWords(campaign.audience)} />
          <StatTile variant="bento" value={String(reachable)} label="Reachable" hint={`${unreachable} have no usable number`} />
          <StatTile variant="bento" value={String(counts.markedSent)} label="Marked sent" hint="you said so — WhatsApp confirms nothing" />
          <StatTile variant="bento" value={String(counts.opened)} label="Chats opened" hint="WhatsApp opened, not yet confirmed" />
          <StatTile variant="bento" value={String(bought)} label="Bought within 7 days" hint="a sale rung up under their name" />
        </View>
        <Caveat tone="context">What the till recorded, not proof the message caused it — walk-ins get the same discount.</Caveat>
      </BentoCard>

      {unreachable > 0 && (
        <Caveat tone="wrong" action={{ label: `Review the ${unreachable}`, onPress: onReviewUnreachable }}>
          {`${unreachable} customer${unreachable === 1 ? '' : 's'} in this audience cannot be reached. Their phone number is missing or too short for WhatsApp to open a chat. Fix a number and they join the queue automatically.`}
        </Caveat>
      )}

      <BentoCard title="What they see">
        {filledMessage ? (
          <View style={styles.bubble}>
            <Text style={styles.bubbleText}>{filledMessage}</Text>
          </View>
        ) : (
          <Text style={styles.empty}>No message written yet.</Text>
        )}
        <Text style={styles.foot}>Written once with placeholders; each chat opens with that customer&apos;s own name already filled in.</Text>
      </BentoCard>

      <BentoCard title="The offer behind it">
        {promotion ? (
          <>
            <KvRow k="Offer" v={promotion.name} />
            <KvRow k="Discount" v={discountLabel(promotion)} />
            <KvRow k="Applies to" v={scopeLabel(promotion)} />
            <KvRow k="Ends" v={endDate ? endDate.toLocaleDateString() : 'No end date'} />
            <KvRow k="At the till" v={promotion.autoApply ? 'Automatic' : 'When picked'} />
            {promotion.archivedAt && (
              <Caveat tone="context">{`${promotion.name} has since been archived and no longer runs at the till — this is what it offered when this campaign used it.`}</Caveat>
            )}
          </>
        ) : (
          <Text style={styles.empty}>No discount — this is a message on its own.</Text>
        )}
      </BentoCard>
    </View>
  );
}

function KvRow({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvKey}>{k}</Text>
      <Text style={styles.kvValue}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { marginBottom: 14 },
  // Matches promotions-tab.tsx's "+ New sale" header action exactly -- both
  // are the primary create action for a sibling section of the same screen.
  actionButton: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  actionButtonSolid: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  actionButtonText: { color: theme.bentoInk2, fontWeight: '700', fontSize: 12.5 },
  actionButtonTextSolid: { color: theme.bentoSurface },
  list: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  rowSelected: { backgroundColor: theme.bentoSoft },
  rowMain: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  rowSub: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2 },
  empty: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  emptyDetail: { alignItems: 'center' },
  errorText: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10 },
  detailStack: { gap: 14 },
  detHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 6 },
  detIdent: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 1, minWidth: 0 },
  detName: { fontSize: 19, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.5 },
  detMeta: { fontSize: 12.5, color: theme.bentoMuted, marginBottom: 12 },
  // Matches product-modal.tsx/customer-modal.tsx's confirmDestructive delete
  // button in color only -- theme.bentoLoss instead of their hardcoded hex,
  // since this is a bento screen and those are plain modals.
  deleteBtn: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  deleteBtnText: { color: theme.bentoLoss, fontWeight: '700', fontSize: 12 },
  continueBtn: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 11, alignItems: 'center', backgroundColor: theme.bentoInk, marginBottom: 14 },
  continueBtnOff: { opacity: 0.45 },
  continueBtnText: { color: theme.bentoSurface, fontWeight: '800', fontSize: 13.5 },
  doneNote: { fontSize: 12.5, fontWeight: '700', color: theme.bentoMuted, marginBottom: 14 },
  tilesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 4 },
  bubble: { backgroundColor: theme.bentoSoft, borderRadius: 14, padding: 14 },
  bubbleText: { fontSize: 13, lineHeight: 20, color: theme.bentoInk },
  foot: { fontSize: 11, color: theme.bentoMuted2, marginTop: 10, lineHeight: 15 },
  kvRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  kvKey: { fontSize: 13, fontWeight: '600', color: theme.bentoInk },
  kvValue: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
});
