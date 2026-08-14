import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Badge } from '@/components/badge';
import { CategoryChip } from '@/components/category-chip';
import { Card } from '@/components/card';
import { AppModal } from '@/components/ui/app-modal';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { audienceSummary, isReachable, matchesAudience, type AudienceFilter } from '@/lib/campaign-audience';
import { createCampaign, updateCampaign, type NewCampaignInput } from '@/lib/campaigns';
import { fillMessage, PLACEHOLDERS, type MessageValues } from '@/lib/campaign-message';
import { CUSTOMER_SEGMENT_LABELS, segmentForCustomer, type CustomerSegment } from '@/lib/customer-segments';
import { isPromotionLive } from '@/lib/discounts';
import { instantToEndDateInput } from '@/lib/promotion-dates';
import { discountLabel, scopeLabel } from '@/lib/promotions';
import type { Campaign, Customer, Promotion } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet, same as
// campaigns-tab.tsx and every other bento sheet.
const theme = Colors.light;

// Supabase rpc()/query errors are plain {code, details, hint, message}
// objects, never instanceof Error -- see the identical comment in
// campaigns-tab.tsx, poster-sheet.tsx and send-queue.tsx, duplicated here for
// the same reason they give: it's three lines, and a shared util file isn't
// worth the indirection.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

// "20% off everything" / "20% off everything by Nike" / "20% off Shoes" --
// copied from campaigns-tab.tsx/send-queue.tsx rather than imported. This
// component is opened FROM campaigns-tab.tsx, so importing back from here
// would be circular, and it's a few lines -- the same tradeoff send-queue.tsx
// already made for the identical function.
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
// inclusive last day. Duplicated for the same circular-import reason as
// offerWords above.
function inclusiveEndDate(promotion: Promotion): Date | null {
  if (!promotion.endsAt) return null;
  const [year, month, day] = instantToEndDateInput(promotion.endsAt).split('-').map(Number);
  return new Date(year, month - 1, day);
}

// `campaigns.name` is NOT NULL, but none of the four steps asks the owner to
// type one -- the offer they picked already says what this is. A promotion's
// own name IS that answer ("Eid weekend -- 20% off" is exactly what an owner
// would call the campaign too); a plain message borrows its own first line so
// the campaign list still shows something meaningful instead of a blank row.
function campaignNameFor(promotion: Promotion | null, template: string | null): string {
  if (promotion) return promotion.name;
  if (template) {
    const firstLine = template.trim().split('\n')[0]?.trim() ?? '';
    if (firstLine.length > 0) return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
  }
  return 'New message';
}

// "About five seconds each -- roughly seven minutes for 84 people." The
// honest cost of the only way this campaign can actually send, stated up
// front rather than discovered at recipient thirty. Omits the per-person
// estimate entirely when there is nobody to send to -- "roughly 0 minutes for
// 0 people" reads like a bug, not a fact.
function paceDescription(reachable: number): string {
  if (reachable === 0) return 'Kaiibi opens WhatsApp with the message written; you press send and come back. About five seconds each.';
  const minutes = Math.max(1, Math.round((reachable * 5) / 60));
  return `Kaiibi opens WhatsApp with the message written; you press send and come back. About five seconds each -- roughly ${minutes} minute${minutes === 1 ? '' : 's'} for ${reachable} ${reachable === 1 ? 'person' : 'people'}.`;
}

const SEGMENT_ORDER: CustomerSegment[] = ['vip', 'regular', 'new', 'at-risk'];

// Which offer is behind the campaign -- a real promotion, chosen from the
// live ones, or a plain message with nothing to redeem. Not `Promotion |
// null` on its own: nothing has been chosen yet only exists for a shop with
// no live promotions at all (see the lazy initializer below), and collapsing
// "no promotions to pick from" and "picked no discount on purpose" into the
// same `null` would make the first render silently commit to the second.
type OfferChoice = { kind: 'promotion'; promotionId: string } | { kind: 'none' };

// One offer/audience/toggle choice, rendered as the `.opt` card the mockup
// (docs/design/marketing-mockup.html, "New campaign" view) uses for every
// pickable row in this sheet -- a radio dot, a title, an optional badge, and
// a description line.
function OptionCard({
  selected,
  title,
  badge,
  description,
  onPress,
  disabled,
}: {
  selected: boolean;
  title: string;
  badge?: ReactNode;
  description: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole={onPress ? 'radio' : undefined}
      accessibilityState={onPress ? { selected } : undefined}
      style={[styles.opt, selected && styles.optOn, disabled && styles.optOff]}
    >
      <View style={styles.optHead}>
        <View style={[styles.radioDot, selected && styles.radioDotOn]} />
        <Text style={styles.optTitle}>{title}</Text>
        {badge}
      </View>
      <Text style={styles.optDesc}>{description}</Text>
    </Pressable>
  );
}

function StepSection({
  number,
  title,
  hint,
  first,
  children,
}: {
  number: number;
  title: string;
  hint?: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={[styles.step, first && styles.stepFirst]}>
      <View style={styles.stepHead}>
        <Text style={styles.stepNo}>STEP {number}</Text>
        <Text style={styles.stepTitle}>{title}</Text>
        {hint ? (
          <Text style={styles.stepHint} numberOfLines={1}>
            {hint}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

// Four decisions, then the send queue takes over -- opened from
// campaigns-tab.tsx's "+ New campaign" header action. Mounted only while
// open, like PosterSheet and SendQueue, so every field below initialises
// fresh each time.
export function CampaignComposer({
  promotions,
  customers,
  lastPurchaseByCustomer,
  onClose,
  onCreated,
}: {
  // Every live-or-not promotion the shop has -- filtered down to the ones
  // inside their window below (isPromotionLive). campaigns-tab.tsx already
  // loaded this for its own list; asking again here would be a second round
  // trip for data it already holds (same reasoning as `promotions` on
  // PosterSheet and SendQueue).
  promotions: readonly Promotion[];
  // Every customer the shop has, and their last-purchase dates -- what
  // `audienceSummary`/`matchesAudience` need to keep step 2's counts live
  // without a network call per keystroke. See the `audience`/`sampleCustomer`
  // memos below.
  customers: readonly Customer[];
  lastPurchaseByCustomer: ReadonlyMap<string, string>;
  onClose: () => void;
  // Fires once the campaign is actually persisted -- `startSending` tells the
  // caller whether to open the send queue for it (Start sending) or just
  // reload the list (Save as draft).
  onCreated: (campaign: Campaign, startSending: boolean) => void;
}) {
  const { shop, activeLocation } = useAuth();

  // A snapshot, not a clock -- taken once, on mount, same as PosterSheet's
  // `now`. This sheet isn't a countdown, and a promotion's window crossing a
  // boundary while it sits open is not a case worth a ticking clock for.
  const [now] = useState(() => Date.now());

  // Promotions a submit-time recheck (see checkPromotionStillLive below) has
  // caught expiring WHILE this sheet sat open -- pulled back out of the list
  // so picking the same dead offer a second time isn't the only option
  // "pick again" leaves the owner. `now` itself deliberately stays a mount
  // snapshot (see above); this is a targeted correction on top of it, not a
  // switch to a live clock for the whole list.
  const [expiredPromotionIds, setExpiredPromotionIds] = useState<ReadonlySet<string>>(new Set());
  const livePromotions = useMemo(
    () => promotions.filter((p) => isPromotionLive(p, now) && !expiredPromotionIds.has(p.id)),
    [promotions, now, expiredPromotionIds]
  );

  // Only offers currently inside their window may be chosen -- advertising an
  // expired one is exactly the failure the poster work already had to fix
  // twice (see poster-sheet.tsx's weekOffers comment). Defaults to the first
  // live promotion when one exists, otherwise "no discount" -- there is
  // nothing else it could default to.
  const [offer, setOffer] = useState<OfferChoice>(() =>
    livePromotions.length > 0 ? { kind: 'promotion', promotionId: livePromotions[0].id } : { kind: 'none' }
  );
  const selectedPromotion = offer.kind === 'promotion' ? (livePromotions.find((p) => p.id === offer.promotionId) ?? null) : null;

  const [filter, setFilter] = useState<AudienceFilter>({ segments: [], tags: [], inactiveDays: null, locationId: null });
  // Remembers the last N typed for "has not bought in N days" so switching
  // the toggle off and back on restores it, instead of resetting to a
  // default every time, AND so the row still shows that number while the
  // toggle is off (see the render below). Plain state, not a ref -- a ref's
  // `.current` is a value React doesn't know to re-render for, and it must
  // not be read during render (react-hooks/refs).
  const [lastInactiveDays, setLastInactiveDays] = useState(30);
  // Whether the "Has not bought in N days" row is toggled on -- deliberately
  // NOT derived from `filter.inactiveDays !== null` (see handleInactiveDaysText
  // below). Clearing every digit while retyping a new number has to leave the
  // TextInput mounted and focused; if visibility were driven by the filter
  // value itself, the instant it dropped to null the field would flip to the
  // static `<Text>{lastInactiveDays}</Text>` below and the owner would lose
  // their place mid-edit.
  const [inactiveOn, setInactiveOn] = useState(false);
  // What the TextInput actually shows -- independent of `filter.inactiveDays`
  // for the same reason: an owner is allowed to see an empty box while typing
  // even though the committed filter value for "empty" is `null`, not `0`.
  const [inactiveDaysText, setInactiveDaysText] = useState('30');

  const [messageEn, setMessageEn] = useState('');
  const [messageSo, setMessageSo] = useState('');
  // Which field a tapped placeholder chip drops its token into. Appends to
  // the end rather than inserting at the cursor -- onSelectionChange has no
  // precedent anywhere else in this codebase, and appending is a plain,
  // reliable way to "drop it in" on every platform this app runs on
  // (including web), without that machinery.
  const [activeField, setActiveField] = useState<'en' | 'so'>('en');

  const [saving, setSaving] = useState<'draft' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once createCampaign succeeds, so a retry after a later failure (e.g.
  // the "mark as sending" step below) patches the SAME row instead of
  // inserting a second campaign for one tap of "Start sending".
  const [createdCampaign, setCreatedCampaign] = useState<Campaign | null>(null);

  // Pure, in-memory recomputation over `customers`/`lastPurchaseByCustomer` --
  // both fetched once by campaigns-tab.tsx before this sheet ever opens.
  // Every keystroke or chip tap only changes `filter`, a plain object in
  // local state; nothing here issues a request, so the "84 reachable of 96"
  // line updates on every change to the audience without ever refetching.
  const audience = useMemo(() => audienceSummary(customers, filter, lastPurchaseByCustomer, now), [customers, filter, lastPurchaseByCustomer, now]);

  // The recipient a real chat would open for -- reachable preferred, so the
  // preview shows a message that could actually be sent, not one for someone
  // the queue would skip straight past. Same derivation as
  // campaigns-tab.tsx's sampleCustomer.
  const sampleCustomer = useMemo(() => {
    const matched = customers.filter((c) => matchesAudience(c, filter, lastPurchaseByCustomer.get(c.id) ?? null, now));
    return matched.find(isReachable) ?? matched[0] ?? null;
  }, [customers, filter, lastPurchaseByCustomer, now]);

  const segmentCounts = useMemo(() => {
    const counts: Record<CustomerSegment, number> = { vip: 0, regular: 0, new: 0, 'at-risk': 0 };
    for (const c of customers) counts[segmentForCustomer(c)]++;
    return counts;
  }, [customers]);

  // Free-text tags, minus 'vip'/'at risk' -- those already drive the segment
  // chips above (see customer-segments.ts's segmentForCustomer), and showing
  // them again here as a second, differently-combined filter (segments are
  // "any of", tags are "all of" -- see campaign-audience.ts) would read as
  // two controls for the same thing.
  const { tags: availableTags, counts: tagCounts } = useMemo(() => {
    const seen = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const c of customers) {
      for (const tag of c.tags) {
        const key = tag.toLowerCase();
        if (key === 'vip' || key === 'at risk' || key === 'at-risk') continue;
        if (!seen.has(key)) seen.set(key, tag);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return { tags: [...seen.values()].sort((a, b) => a.localeCompare(b)), counts };
  }, [customers]);

  function toggleSegment(segment: CustomerSegment) {
    setFilter((prev) => ({
      ...prev,
      segments: prev.segments.includes(segment) ? prev.segments.filter((s) => s !== segment) : [...prev.segments, segment],
    }));
  }

  function toggleTag(tag: string) {
    const key = tag.toLowerCase();
    setFilter((prev) => {
      const owned = prev.tags.map((t) => t.toLowerCase());
      return { ...prev, tags: owned.includes(key) ? prev.tags.filter((t) => t.toLowerCase() !== key) : [...prev.tags, tag] };
    });
  }

  function toggleInactiveFilter() {
    setInactiveOn((prevOn) => {
      const next = !prevOn;
      setFilter((prev) => ({ ...prev, inactiveDays: next ? lastInactiveDays : null }));
      if (next) setInactiveDaysText(String(lastInactiveDays));
      return next;
    });
  }

  // An empty or zero field means "no opinion about purchase history" (`null`),
  // never `0` -- matchesAudience's `now - lastPurchase < inactiveDays * DAY_MS`
  // is true for essentially everyone when inactiveDays is 0, so a blank digit
  // box hit at the wrong instant would silently save "no purchase-history
  // opinion" as if it were a deliberately chosen 0-day filter. The box itself
  // stays open and editable either way -- see inactiveOn above.
  function handleInactiveDaysText(text: string) {
    const digits = text.replace(/[^0-9]/g, '');
    setInactiveDaysText(digits);
    const parsed = digits === '' ? 0 : Number(digits);
    if (parsed > 0) setLastInactiveDays(parsed);
    setFilter((prev) => ({ ...prev, inactiveDays: parsed > 0 ? parsed : null }));
  }

  function insertPlaceholder(token: string) {
    const append = (prev: string) => (prev.length > 0 && !prev.endsWith(' ') ? `${prev} ${token}` : `${prev}${token}`);
    if (activeField === 'en') setMessageEn(append);
    else setMessageSo(append);
  }

  // English preferred, matching campaigns-tab.tsx's
  // `campaign.messageEn ?? campaign.messageSo ?? null` -- an owner who has
  // only written the Somali draft still gets a live preview.
  const messageTemplate = messageEn.trim().length > 0 ? messageEn : messageSo.trim().length > 0 ? messageSo : null;
  const endDate = selectedPromotion ? inclusiveEndDate(selectedPromotion) : null;
  const messageValues: MessageValues = {
    name: sampleCustomer?.firstName ?? 'there',
    shop: shop?.name ?? '',
    offer: offerWords(selectedPromotion),
    ends: endDate ? endDate.toLocaleDateString(undefined, { weekday: 'long' }) : '',
    branch: activeLocation?.name ?? '',
  };
  const filledMessage = messageTemplate ? fillMessage(messageTemplate, messageValues) : null;

  // Two different problems with two different fixes -- widening the audience
  // vs. fixing a phone number -- so "Start sending" says which one it is
  // rather than sitting dead with no explanation. Null once there is anyone
  // to send to.
  const zeroReason: string | null =
    audience.reachable > 0
      ? null
      : audience.matched === 0
        ? 'Nobody matches this audience yet. Widen the segments, tags or purchase-history filter above to find recipients.'
        : `Every one of the ${audience.matched} ${audience.matched === 1 ? 'customer' : 'customers'} who match${audience.matched === 1 ? 'es' : ''} this audience has no usable phone number. Fix one in Customers and they join the queue automatically.`;

  // Nothing checks the message fields on their own -- `messageEn: null,
  // messageSo: null` is a perfectly valid campaign as far as the database is
  // concerned, and there is no "open an existing campaign" mode to fix it
  // afterward (see deleteCampaign's wiring in campaigns-tab.tsx for the other
  // half of that trap). A trimmed, non-empty English OR Somali line is the
  // bar -- same "English preferred, Somali optional" shape as messageTemplate
  // above.
  const hasMessage = messageEn.trim().length > 0 || messageSo.trim().length > 0;
  const messageReason: string | null = hasMessage
    ? null
    : 'Nothing is written yet. Add an English or Somali message in Step 3 above — there has to be something for a customer to read.';

  function buildInput(): NewCampaignInput {
    return {
      promotionId: offer.kind === 'promotion' ? offer.promotionId : null,
      name: campaignNameFor(selectedPromotion, messageTemplate),
      messageEn: messageEn.trim() || null,
      messageSo: messageSo.trim() || null,
      audience: filter,
    };
  }

  // Creates the campaign on the first call; every call after that PATCHES the
  // same row instead of inserting a second one -- otherwise retrying after a
  // failure (see handleStartSending) would duplicate the campaign for one tap
  // of a button. Patching on every call, rather than only creating once and
  // reusing that snapshot forever, also means a field edited AFTER a failed
  // "Start sending" (the offer, the audience, the message) is not silently
  // dropped on retry -- the row is brought current, not just reused stale.
  async function ensureCampaign(): Promise<Campaign> {
    if (!shop) throw new Error('No shop selected.');
    const campaign = createdCampaign ? await updateCampaign(createdCampaign.id, buildInput()) : await createCampaign(shop.id, buildInput());
    setCreatedCampaign(campaign);
    return campaign;
  }

  // `now` above is a mount-time snapshot -- exactly the gap that let an
  // expired offer still be advertised twice before (see poster-sheet.tsx's
  // weekOffers comment). A phone call, a backgrounded app, or a promotion
  // simply ending mid-write can all leave this sheet open past `endsAt`
  // without anything on screen saying so. This re-checks with the actual
  // clock at the one moment that matters -- right before either button
  // writes anything -- rather than trusting the stale `livePromotions` list
  // the offer was originally picked from.
  function checkPromotionStillLive(): boolean {
    if (offer.kind !== 'promotion') return true;
    const chosen = promotions.find((p) => p.id === offer.promotionId);
    if (chosen && isPromotionLive(chosen, Date.now())) return true;
    setExpiredPromotionIds((prev) => new Set(prev).add(offer.promotionId));
    setOffer({ kind: 'none' });
    setError(
      `"${chosen?.name ?? 'That offer'}" has ended since you opened this campaign. Pick another offer in Step 1, or choose "Just a message, no discount" to continue.`
    );
    return false;
  }

  async function handleSaveDraft() {
    setError(null);
    if (!checkPromotionStillLive()) return;
    setSaving('draft');
    try {
      const campaign = await ensureCampaign();
      onCreated(campaign, false);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save this campaign.'));
    } finally {
      setSaving(null);
    }
  }

  async function handleStartSending() {
    setError(null);
    if (!checkPromotionStillLive()) return;
    setSaving('start');
    try {
      const base = await ensureCampaign();
      const started = await updateCampaign(base.id, { status: 'sending', startedAt: new Date().toISOString() });
      onCreated(started, true);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not start sending.'));
    } finally {
      setSaving(null);
    }
  }

  const busy = saving !== null;

  return (
    <AppModal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.headTitle}>New campaign</Text>
            <Pressable onPress={onClose} accessibilityRole="button" style={styles.headBtn}>
              <Text style={styles.headBtnText}>Cancel</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Card variant="bento" style={styles.card}>
              <StepSection number={1} title="What is the offer?" first>
                <View style={styles.optsCol}>
                  {livePromotions.map((p) => {
                    const promoEndDate = inclusiveEndDate(p);
                    const endsClause = promoEndDate
                      ? `ends ${promoEndDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
                      : 'no end date';
                    return (
                      <OptionCard
                        key={p.id}
                        selected={offer.kind === 'promotion' && offer.promotionId === p.id}
                        onPress={() => setOffer({ kind: 'promotion', promotionId: p.id })}
                        title={p.name}
                        badge={<Badge variant="bento" tone="success" label="Live" />}
                        description={`${discountLabel(p)} · ${scopeLabel(p)} · ${endsClause}`}
                      />
                    );
                  })}
                  <OptionCard
                    selected={offer.kind === 'none'}
                    onPress={() => setOffer({ kind: 'none' })}
                    title="Just a message, no discount"
                    description="New stock, opening hours, a thank-you."
                  />
                </View>
              </StepSection>

              <StepSection number={2} title="Who gets it?" hint={`${audience.reachable} reachable of ${audience.matched}`}>
                <View style={styles.chipRow}>
                  <CategoryChip
                    variant="bento"
                    label={`Everyone · ${customers.length}`}
                    active={filter.segments.length === 0}
                    onPress={() => setFilter((prev) => ({ ...prev, segments: [] }))}
                  />
                  {SEGMENT_ORDER.map((segment) => (
                    <CategoryChip
                      key={segment}
                      variant="bento"
                      label={`${CUSTOMER_SEGMENT_LABELS[segment]} · ${segmentCounts[segment]}`}
                      active={filter.segments.includes(segment)}
                      onPress={() => toggleSegment(segment)}
                    />
                  ))}
                </View>

                {availableTags.length > 0 && (
                  <View style={[styles.chipRow, styles.chipRowSpaced]}>
                    {availableTags.map((tag) => (
                      <CategoryChip
                        key={tag}
                        variant="bento"
                        label={`${tag} · ${tagCounts.get(tag.toLowerCase()) ?? 0}`}
                        active={filter.tags.some((t) => t.toLowerCase() === tag.toLowerCase())}
                        onPress={() => toggleTag(tag)}
                      />
                    ))}
                  </View>
                )}

                <View style={[styles.opt, styles.inactiveOpt, inactiveOn && styles.optOn]}>
                  <View style={styles.optHead}>
                    {/* Only the dot+label toggle the filter -- the number field
                        below is a sibling, not nested inside this Pressable,
                        so editing it can never also fire the toggle. */}
                    <Pressable
                      onPress={toggleInactiveFilter}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: inactiveOn }}
                      hitSlop={6}
                      style={styles.inactiveToggleTap}
                    >
                      <View style={[styles.radioDot, inactiveOn && styles.radioDotOn]} />
                      <Text style={styles.optTitle}>Has not bought in</Text>
                    </Pressable>
                    {inactiveOn ? (
                      <TextInput
                        value={inactiveDaysText}
                        onChangeText={handleInactiveDaysText}
                        keyboardType="number-pad"
                        style={styles.inactiveInput}
                      />
                    ) : (
                      <Text style={styles.optTitle}>{lastInactiveDays}</Text>
                    )}
                    <Text style={styles.optTitle}>days</Text>
                  </View>
                  <Text style={styles.optDesc}>From their purchase history in Customers.</Text>
                </View>

                {audience.unreachable > 0 && (
                  <Caveat tone="partial">
                    {`${audience.unreachable} of the ${audience.matched} have no usable phone number. They stay in the audience and join the queue the moment a number is fixed.`}
                  </Caveat>
                )}
              </StepSection>

              <StepSection number={3} title="What does it say?">
                <Text style={styles.fieldLabel}>PLACEHOLDERS · TAP TO INSERT</Text>
                <View style={styles.chipRow}>
                  {PLACEHOLDERS.map((token) => (
                    <Pressable key={token} onPress={() => insertPlaceholder(token)} style={styles.tokenChip}>
                      <Text style={styles.tokenChipText}>{token}</Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.fieldLabel}>ENGLISH</Text>
                <TextInput
                  value={messageEn}
                  onChangeText={setMessageEn}
                  onFocus={() => setActiveField('en')}
                  multiline
                  placeholder="Hi {name} — {offer} at {shop} until {ends}."
                  placeholderTextColor={theme.bentoMuted2}
                  style={styles.field}
                />

                <Text style={styles.fieldLabel}>SOMALI</Text>
                <TextInput
                  value={messageSo}
                  onChangeText={setMessageSo}
                  onFocus={() => setActiveField('so')}
                  multiline
                  placeholder="Optional — the same message in Somali."
                  placeholderTextColor={theme.bentoMuted2}
                  style={styles.field}
                />

                <Text style={styles.fieldLabel}>WHAT THEY SEE</Text>
                {!messageTemplate ? (
                  <Text style={styles.empty}>Write a message above to see how it will look.</Text>
                ) : !sampleCustomer ? (
                  <Text style={styles.empty}>Nobody matches this audience yet — the preview will use a real customer once someone does.</Text>
                ) : (
                  <View style={styles.bubble}>
                    <Text style={styles.bubbleText}>{filledMessage}</Text>
                  </View>
                )}
                <Text style={styles.foot}>Each chat opens with that customer&apos;s own name already filled in — the customer never sees a brace.</Text>
              </StepSection>

              <StepSection number={4} title="How does it go out?">
                <View style={styles.optsCol}>
                  <OptionCard
                    selected
                    title="One chat at a time"
                    badge={<Badge variant="bento" tone="success" label="Free" />}
                    description={paceDescription(audience.reachable)}
                  />
                  <OptionCard
                    selected={false}
                    disabled
                    title="Send them all at once"
                    badge={<Badge variant="bento" tone="default" label="Not connected" />}
                    description="Needs a WhatsApp Business account, a dedicated number, and Meta's approval of the message wording."
                  />
                </View>
              </StepSection>

              {messageReason && <Caveat tone="wrong">{messageReason}</Caveat>}
              {zeroReason && <Caveat tone="wrong">{zeroReason}</Caveat>}
              {error && <Text style={styles.error}>{error}</Text>}

              <View style={styles.footer}>
                <Pressable
                  disabled={busy || !shop || !hasMessage}
                  onPress={handleSaveDraft}
                  accessibilityRole="button"
                  style={[styles.secondaryBtn, (busy || !shop || !hasMessage) && styles.btnOff]}
                >
                  <Text style={styles.secondaryBtnText}>{saving === 'draft' ? 'Saving…' : 'Save as draft'}</Text>
                </Pressable>
                <Pressable
                  disabled={busy || !shop || !hasMessage || audience.reachable === 0}
                  onPress={handleStartSending}
                  accessibilityRole="button"
                  style={[styles.primaryBtn, (busy || !shop || !hasMessage || audience.reachable === 0) && styles.btnOff]}
                >
                  <Text style={styles.primaryBtnText}>{saving === 'start' ? 'Starting…' : `Start sending · ${audience.reachable}`}</Text>
                </Pressable>
              </View>
            </Card>
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.bentoPage, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '92%' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16, paddingTop: 16 },
  headTitle: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk },
  headBtn: { borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  headBtnText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoInk2 },
  body: { padding: 16, paddingTop: 12 },
  card: { padding: 18 },

  step: { borderTopWidth: 1, borderTopColor: theme.bentoLine, paddingTop: 16, marginTop: 16 },
  stepFirst: { borderTopWidth: 0, paddingTop: 0, marginTop: 0 },
  stepHead: { flexDirection: 'row', alignItems: 'baseline', gap: 9, marginBottom: 10, flexWrap: 'wrap' },
  stepNo: { fontSize: 10.5, fontWeight: '800', color: theme.bentoMuted2, letterSpacing: 0.6 },
  stepTitle: { fontSize: 14, fontWeight: '800', color: theme.bentoInk },
  stepHint: { fontSize: 11.5, color: theme.bentoMuted, marginLeft: 'auto' },

  optsCol: { gap: 8 },
  opt: { backgroundColor: theme.bentoSoft, borderWidth: 1.5, borderColor: 'transparent', borderRadius: 16, padding: 13 },
  optOn: { borderColor: theme.bentoInk, backgroundColor: theme.bentoSurface },
  optOff: { opacity: 0.55 },
  optHead: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  optTitle: { fontSize: 13, fontWeight: '800', color: theme.bentoInk },
  optDesc: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 4, lineHeight: 16 },
  radioDot: { width: 15, height: 15, borderRadius: 8, borderWidth: 1.5, borderColor: theme.bentoRule, backgroundColor: theme.bentoSurface },
  radioDotOn: { borderColor: theme.bentoInk, borderWidth: 4.5 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipRowSpaced: { marginTop: 10 },

  inactiveOpt: { marginTop: 10 },
  inactiveToggleTap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inactiveInput: {
    minWidth: 34,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '800',
    color: theme.bentoInk,
    backgroundColor: theme.bentoSurface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    paddingVertical: 2,
    paddingHorizontal: 6,
  },

  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: theme.bentoMuted, marginBottom: 6, marginTop: 12 },
  field: { backgroundColor: theme.bentoSoft, borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 14, padding: 12, minHeight: 88, fontSize: 13, lineHeight: 19, color: theme.bentoInk2, textAlignVertical: 'top' },
  tokenChip: { backgroundColor: theme.bentoAccentWash, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5 },
  tokenChipText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoAccentInk },

  bubble: { backgroundColor: theme.bentoSoft, borderRadius: 14, padding: 13 },
  bubbleText: { fontSize: 13, lineHeight: 20, color: theme.bentoInk },
  foot: { fontSize: 11, color: theme.bentoMuted2, marginTop: 8, lineHeight: 15 },
  empty: { fontSize: 12.5, color: theme.bentoMuted, paddingVertical: 6 },

  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 14 },
  footer: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: theme.bentoLine },
  secondaryBtn: { flex: 1, borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 14, height: 46, alignItems: 'center', justifyContent: 'center' },
  secondaryBtnText: { color: theme.bentoInk2, fontSize: 13.5, fontWeight: '700' },
  primaryBtn: { flex: 1, backgroundColor: theme.bentoInk, borderRadius: 14, height: 46, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { color: theme.bentoSurface, fontSize: 13.5, fontWeight: '800' },
  btnOff: { opacity: 0.45 },
});
