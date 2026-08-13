import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View, type AppStateStatus } from 'react-native';

import { Badge, type BadgeTone } from '@/components/badge';
import { AppModal } from '@/components/ui/app-modal';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { isReachable, matchesAudience } from '@/lib/campaign-audience';
import { fillMessage, type MessageValues } from '@/lib/campaign-message';
import { countRecipients } from '@/lib/campaign-metrics';
import { listRecipients, setRecipientState, syncRecipients } from '@/lib/campaigns';
import { customerDisplayName } from '@/lib/customers';
import { CUSTOMER_SEGMENT_LABELS, segmentForCustomer } from '@/lib/customer-segments';
import { instantToEndDateInput } from '@/lib/promotion-dates';
import { discountLabel } from '@/lib/promotions';
import { openWhatsApp } from '@/lib/whatsapp';
import type { Campaign, CampaignRecipient, Customer, Promotion, RecipientState } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet, same as
// campaigns-tab.tsx.
const theme = Colors.light;

// Supabase rpc()/query errors are plain {code, details, hint, message}
// objects, never instanceof Error -- see the identical comment in
// campaigns-tab.tsx and poster-sheet.tsx, duplicated here for the same reason
// they gave: it's three lines, and a shared util file isn't worth the
// indirection.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

// "20% off everything" / "20% off everything by Nike" / "20% off Shoes" --
// copied from campaigns-tab.tsx rather than imported: that file renders the
// campaign LIST and this one renders the send queue, and campaigns-tab.tsx
// is the one that will import SendQueue to open it, so importing back from
// here would be circular. Same wording so the preview a customer already saw
// in the detail pane matches what actually gets typed into their chat.
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
// inclusive last day. Duplicated from campaigns-tab.tsx for the same
// circular-import reason as offerWords above.
function inclusiveEndDate(promotion: Promotion): Date | null {
  if (!promotion.endsAt) return null;
  const [year, month, day] = instantToEndDateInput(promotion.endsAt).split('-').map(Number);
  return new Date(year, month - 1, day);
}

// A nudge, not a gate -- WhatsApp rate-limits and can ban a shop's own number
// for messaging dozens of non-contacts in a burst. Read from the PERSISTED
// count of everyone marked sent so far (not a local counter), so it fires at
// the right multiple even across closing and reopening the queue mid-run.
const SENT_BREAK_INTERVAL = 20;

function recipientStatus(recipient: CampaignRecipient, customer: Customer | undefined): { label: string; tone: BadgeTone } {
  switch (recipient.state) {
    case 'sent':
      return {
        label: recipient.sentAt
          ? `sent ${new Date(recipient.sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
          : 'sent',
        tone: 'success',
      };
    case 'opened':
      // Deliberately the same wording whether or not the return-to-foreground
      // question is on screen right now -- 'opened' always means exactly this:
      // a chat was handed over and nobody has said what happened next.
      return { label: 'chat opened — send?', tone: 'warning' };
    case 'skipped':
      return { label: 'skipped', tone: 'default' };
    case 'unreachable':
      return { label: 'no usable number', tone: 'default' };
    case 'waiting':
    default:
      // 'waiting' rows are unreachable in the SAME words as an explicit
      // 'unreachable' state, on purpose -- see the comment on `current` below
      // for why this is derived rather than written back to the row.
      return customer && isReachable(customer) ? { label: 'waiting', tone: 'default' } : { label: 'no usable number', tone: 'default' };
  }
}

export function SendQueue({
  campaign,
  promotion,
  customers,
  lastPurchaseByCustomer,
  onClose,
}: {
  campaign: Campaign;
  promotion: Promotion | null;
  // Every customer the shop has, and their last-purchase dates -- the parent
  // (campaigns-tab.tsx) already loaded both for its own audience tiles, so
  // asking again here would be a second round trip for data it already holds
  // (same reasoning as `promotions` on PosterSheet).
  customers: readonly Customer[];
  lastPurchaseByCustomer: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const { shop, activeLocation } = useAuth();

  const [recipients, setRecipients] = useState<CampaignRecipient[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [addedCount, setAddedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Who the "did that send?" question is about. A ref because the AppState
  // listener below is registered once on mount and must read the CURRENT
  // value on a background->active edge that can happen long after that
  // effect ran -- a value captured in the effect's closure would be stale.
  // `askingId` mirrors it into state purely to drive the confirm modal's
  // render; the two are only ever set together, by `setPending`.
  const pendingIdRef = useRef<string | null>(null);
  const [askingId, setAskingId] = useState<string | null>(null);
  function setPending(id: string | null) {
    pendingIdRef.current = id;
    setAskingId(id);
  }

  const customersById = useMemo(() => new Map(customers.map((c) => [c.id, c] as const)), [customers]);

  // Top up on open: re-evaluate the audience filter against the customer list
  // the parent just loaded and sync it, so a customer whose number was fixed
  // (or who newly matches the filter) joins this run.
  //
  // Runs once, on mount, keyed only to campaign.id -- not to `customers` or
  // `lastPurchaseByCustomer`. Those are a snapshot of "the audience as of
  // opening the queue"; re-running this every time the parent's own data
  // refreshes underneath (e.g. a pull-to-refresh on the list behind this
  // modal) would silently re-top-up mid-session and reset `addedCount`'s
  // one-time banner on every unrelated re-render.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const matchedIds = customers
          .filter((c) => matchesAudience(c, campaign.audience, lastPurchaseByCustomer.get(c.id) ?? null))
          .map((c) => c.id);
        const added = await syncRecipients(campaign.id, matchedIds);
        const fresh = await listRecipients(campaign.id);
        if (cancelled) return;
        setRecipients(fresh);
        setAddedCount(added);
      } catch (err) {
        if (!cancelled) setError(extractErrorMessage(err, 'Could not load this queue.'));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id]);

  // AppState has no other precedent in this codebase -- read
  // https://reactnative.dev/docs/appstate before touching this. Two things
  // from it matter here:
  //
  // 1. 'change' fires on every transition (active/background/inactive, the
  //    last iOS-only), not only the one this screen cares about. The signal
  //    this needs is specifically a background/inactive -> active EDGE, which
  //    has to be computed by comparing consecutive events -- there is no
  //    dedicated "became active" event to subscribe to instead.
  // 2. addEventListener returns a subscription object, and THAT owns removal
  //    (`.remove()`) -- AppState.removeEventListener doesn't exist on the
  //    current API. Skipping cleanup means every reopened queue adds another
  //    listener that fires (and calls setPending) alongside all the others.
  useEffect(() => {
    let previous: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      const wasAway = previous === 'background' || previous === 'inactive';
      previous = next;
      // Ask ONCE about the recipient whose chat was just opened. `pendingIdRef`
      // is cleared the moment that question is answered (see handleAnswer), so
      // a later foreground edge with nothing pending is a no-op -- and a
      // foreground edge that arrives again before it's answered just re-shows
      // the SAME question rather than a second one, since `next` state is
      // idempotent for an unchanged id.
      if (wasAway && next === 'active' && pendingIdRef.current) {
        setAskingId(pendingIdRef.current);
      }
    });
    return () => subscription.remove();
  }, []);

  function patchRecipient(id: string, patch: Partial<CampaignRecipient>) {
    setRecipients((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  // Constant for every recipient in this run -- only {name} differs per
  // person, filled in at send time below.
  const baseValues: Omit<MessageValues, 'name'> = useMemo(() => {
    const endDate = promotion ? inclusiveEndDate(promotion) : null;
    return {
      shop: shop?.name ?? '',
      offer: offerWords(promotion),
      ends: endDate ? endDate.toLocaleDateString(undefined, { weekday: 'long' }) : '',
      branch: activeLocation?.name ?? '',
    };
  }, [promotion, shop?.name, activeLocation?.name]);

  const messageTemplate = campaign.messageEn ?? campaign.messageSo ?? null;

  // Stable order, independent of anything that can change underneath (a
  // recipient's state, a customer's phone number) -- otherwise the list would
  // reshuffle under the owner's thumb as they work through it. Two customers
  // sharing a name still sort deterministically because id is the tiebreak,
  // and both remain individually addressable everywhere below by phone number
  // and recipient id, never by name alone.
  const ordered = useMemo(() => {
    return [...recipients].sort((a, b) => {
      const an = customersById.get(a.customerId);
      const bn = customersById.get(b.customerId);
      const cmp = (an ? customerDisplayName(an) : '').localeCompare(bn ? customerDisplayName(bn) : '');
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });
  }, [recipients, customersById]);

  // The next person to act on: the first 'waiting' recipient whose customer
  // is reachable right now. Deliberately re-evaluated live against `customer`
  // rather than ever writing 'unreachable' onto a row automatically -- a row
  // stays 'waiting' until the owner (or a real send attempt) says otherwise,
  // so the moment a phone number is fixed this same row becomes reachable and
  // 'current' again with no write needed. Auto-writing 'unreachable' here
  // would be a one-way ratchet that breaks exactly the "fix a number, they
  // rejoin" guarantee syncRecipients exists for.
  const current = useMemo(
    () =>
      ordered.find((r) => {
        if (r.state !== 'waiting') return false;
        const customer = customersById.get(r.customerId);
        return customer ? isReachable(customer) : false;
      }) ?? null,
    [ordered, customersById]
  );
  const currentCustomer = current ? (customersById.get(current.customerId) ?? null) : null;

  const askingRecipient = askingId ? (recipients.find((r) => r.id === askingId) ?? null) : null;
  const askingCustomer = askingRecipient ? (customersById.get(askingRecipient.customerId) ?? null) : null;

  const counts = countRecipients(recipients);
  const showBreakCaveat = counts.markedSent > 0 && counts.markedSent % SENT_BREAK_INTERVAL === 0;

  async function handleOpenWhatsApp() {
    if (!current || !currentCustomer || !currentCustomer.phone || !messageTemplate) return;
    const message = fillMessage(messageTemplate, { ...baseValues, name: currentCustomer.firstName });
    setBusy(true);
    setError(null);
    try {
      // Persisted BEFORE openWhatsApp runs, not after. openWhatsApp is about
      // to hand control to the OS and background this app -- code written
      // after that call is not guaranteed to run at all.
      await setRecipientState(current.id, 'opened');
      patchRecipient(current.id, { state: 'opened', openedAt: new Date().toISOString() });
      setPending(current.id);
      openWhatsApp(currentCustomer.phone, message);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not open WhatsApp for this recipient.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleSecondary(state: 'skipped' | 'unreachable') {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await setRecipientState(current.id, state);
      patchRecipient(current.id, { state });
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not update this recipient.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleAnswer(sent: boolean) {
    if (!askingId) return;
    const id = askingId;
    const nextState: RecipientState = sent ? 'sent' : 'waiting';
    setBusy(true);
    setError(null);
    try {
      await setRecipientState(id, nextState);
      patchRecipient(id, { state: nextState, sentAt: sent ? new Date().toISOString() : null });
      setPending(null);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save your answer.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppModal visible animationType="slide" transparent onRequestClose={onClose}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.head}>
              <Text style={styles.headTitle} numberOfLines={1}>
                Sending · {campaign.name}
              </Text>
              <Pressable onPress={onClose} accessibilityRole="button" style={styles.headBtn}>
                <Text style={styles.headBtnText}>Close</Text>
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.body}>
              {error && <Text style={styles.error}>{error}</Text>}

              {!loaded ? (
                <Text style={styles.empty}>Loading…</Text>
              ) : (
                <>
                  {addedCount > 0 && (
                    <Caveat tone="context">{`${addedCount} more customer${addedCount === 1 ? '' : 's'} can be reached now.`}</Caveat>
                  )}

                  {!messageTemplate ? (
                    <Text style={styles.empty}>No message has been written for this campaign yet.</Text>
                  ) : current && currentCustomer ? (
                    <BentoCard>
                      <Text style={styles.currentName}>{customerDisplayName(currentCustomer)}</Text>
                      <Text style={styles.currentMeta}>
                        {currentCustomer.phone} · {CUSTOMER_SEGMENT_LABELS[segmentForCustomer(currentCustomer)]}
                      </Text>
                      <Text style={styles.currentMeta}>
                        Last bought{' '}
                        {lastPurchaseByCustomer.get(currentCustomer.id)
                          ? new Date(lastPurchaseByCustomer.get(currentCustomer.id)!).toLocaleDateString()
                          : 'never'}
                      </Text>

                      <Pressable
                        disabled={busy}
                        onPress={handleOpenWhatsApp}
                        accessibilityRole="button"
                        style={[styles.primary, busy && styles.actionOff]}
                      >
                        <Text style={styles.primaryText}>Open WhatsApp for {currentCustomer.firstName}</Text>
                      </Pressable>
                      <View style={styles.secondaryRow}>
                        <Pressable
                          disabled={busy}
                          onPress={() => handleSecondary('skipped')}
                          accessibilityRole="button"
                          style={[styles.secondary, styles.secondaryHalf, busy && styles.actionOff]}
                        >
                          <Text style={styles.secondaryText}>Skip this person</Text>
                        </Pressable>
                        <Pressable
                          disabled={busy}
                          onPress={() => handleSecondary('unreachable')}
                          accessibilityRole="button"
                          style={[styles.secondary, styles.secondaryHalf, busy && styles.actionOff]}
                        >
                          <Text style={styles.secondaryText}>Not reachable</Text>
                        </Pressable>
                      </View>
                    </BentoCard>
                  ) : (
                    <Text style={styles.empty}>Nothing left to send right now.</Text>
                  )}

                  {showBreakCaveat && (
                    <Caveat tone="context">
                      {`${counts.markedSent} marked sent this run — WhatsApp can rate-limit or ban a number that messages many people in a burst. Worth a short break before the next one.`}
                    </Caveat>
                  )}

                  <BentoCard title="Queue" bodyStyle={styles.queueBody}>
                    {ordered.length === 0 ? (
                      <Text style={styles.empty}>Nobody matches this audience yet.</Text>
                    ) : (
                      ordered.map((r) => {
                        const customer = customersById.get(r.customerId);
                        const status = recipientStatus(r, customer);
                        return (
                          <View key={r.id} style={styles.queueRow}>
                            <Text style={styles.queueName} numberOfLines={1}>
                              {customer ? customerDisplayName(customer) : 'Unknown customer'}
                            </Text>
                            <Badge variant="bento" label={status.label} tone={status.tone} />
                          </View>
                        );
                      })
                    )}
                  </BentoCard>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </AppModal>

      {askingId && (
        <AppModal visible animationType="fade" transparent onRequestClose={() => {}}>
          <View style={styles.confirmOverlay}>
            <View style={styles.confirmSheet}>
              <Text style={styles.confirmTitle}>{`Did that send${askingCustomer ? ` to ${askingCustomer.firstName}` : ''}?`}</Text>
              <Pressable disabled={busy} onPress={() => handleAnswer(true)} accessibilityRole="button" style={[styles.primary, busy && styles.actionOff]}>
                <Text style={styles.primaryText}>Yes, sent</Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={() => handleAnswer(false)}
                accessibilityRole="button"
                style={[styles.secondary, styles.confirmNo, busy && styles.actionOff]}
              >
                <Text style={styles.secondaryText}>No — try again later</Text>
              </Pressable>
            </View>
          </View>
        </AppModal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.bentoPage, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '92%' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16, paddingTop: 16 },
  headTitle: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk },
  headBtn: { borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  headBtnText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoInk2 },
  body: { padding: 16, paddingTop: 12, gap: 14 },
  empty: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700' },
  currentName: { fontSize: 18, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.3 },
  currentMeta: { fontSize: 12.5, color: theme.bentoMuted, marginTop: 3 },
  primary: { backgroundColor: theme.bentoInk, borderRadius: 14, height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  primaryText: { color: theme.bentoSurface, fontSize: 14, fontWeight: '800' },
  secondaryRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  secondaryHalf: { flex: 1 },
  secondary: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 14, height: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: theme.bentoInk2, fontSize: 13, fontWeight: '700' },
  actionOff: { opacity: 0.5 },
  queueBody: { gap: 0 },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoLine,
  },
  queueName: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '600', color: theme.bentoInk },
  confirmOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  confirmSheet: { width: '100%', maxWidth: 340, backgroundColor: theme.bentoPage, borderRadius: 20, padding: 20 },
  confirmTitle: { fontSize: 16, fontWeight: '800', color: theme.bentoInk, marginBottom: 16, textAlign: 'center' },
  confirmNo: { marginTop: 8 },
});
