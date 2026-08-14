import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View, type AppStateStatus } from 'react-native';

import { Badge, type BadgeTone } from '@/components/badge';
import { AppModal } from '@/components/ui/app-modal';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { isReachable, matchesAudience } from '@/lib/campaign-audience';
import { confirmTriChoice, type TriChoiceAnswer } from '@/lib/confirm';
import { fillMessage, type MessageValues } from '@/lib/campaign-message';
import { countRecipients, hasRecipientsLeftToActOn } from '@/lib/campaign-metrics';
import { listRecipients, setRecipientState, syncRecipients, updateCampaign } from '@/lib/campaigns';
import { customerDisplayName } from '@/lib/customers';
import { CUSTOMER_SEGMENT_LABELS, segmentForCustomer } from '@/lib/customer-segments';
import { promotionLiveIssue } from '@/lib/discounts';
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
  //
  // `setPending` writes ONLY the ref. It does NOT touch `askingId` -- the
  // question must appear when the owner comes BACK to the app, not at the
  // moment they tap "Open WhatsApp" and leave it. (That was the original bug:
  // both used to be written together here, so the dialog rendered before the
  // app ever backgrounded, and the AppState listener's `setAskingId` below
  // was a no-op because the value was already equal.) `askingId` is set only
  // from the background->active edge itself, or by tapping an already-
  // 'opened' row to ask again (see `reaskAbout`).
  const pendingIdRef = useRef<string | null>(null);
  const [askingId, setAskingId] = useState<string | null>(null);
  function setPending(id: string | null) {
    pendingIdRef.current = id;
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
        // Fetched BEFORE syncing so "who's new" can be worked out locally --
        // syncRecipients's own return value is a row-insert count, not a
        // list of who those rows were for, and it doesn't know about phone
        // numbers at all (see the reachability filter below).
        const before = await listRecipients(campaign.id);
        const existingCustomerIds = new Set(before.map((r) => r.customerId));
        const matched = customers.filter((c) => matchesAudience(c, campaign.audience, lastPurchaseByCustomer.get(c.id) ?? null));
        const matchedIds = matched.map((c) => c.id);
        // "N more customers can be reached now" must mean exactly that.
        // matchesAudience deliberately ignores phone numbers -- a newly
        // matching customer with none still joins the queue below (so they
        // show as "no usable number" and rejoin properly once it's fixed),
        // but announcing them as reachable would be wrong the moment the
        // owner reads the banner.
        const newlyReachable = matched.filter((c) => !existingCustomerIds.has(c.id) && isReachable(c)).length;
        try {
          await syncRecipients(campaign.id, matchedIds);
        } catch (err) {
          // A failed top-up must not hide the people already queued
          // server-side -- fall through to the listRecipients below instead
          // of bailing, so an owner reopening mid-run still sees their 84
          // rows instead of "Nobody matches this audience yet".
          if (!cancelled) setError(extractErrorMessage(err, 'Could not check for new recipients.'));
        }
        const fresh = await listRecipients(campaign.id);
        if (cancelled) return;
        setRecipients(fresh);
        setAddedCount(newlyReachable);
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

  // Maintains campaign.status -- nothing else in this branch ever writes
  // 'sending' outside campaign-composer.tsx's "Start sending" at CREATION
  // time, and nothing else writes 'done' at all (see the migration's check
  // constraint for the three values this is meant to cycle through). Without
  // this a "Continue sending" campaign chips "Sending 84 of 84" forever, and
  // its Continue button never goes away, even once nobody is left to act on.
  //
  // 'sending' fires the moment this queue is opened for a 'draft' campaign --
  // opening it to work it out at all is "starting to work the queue", the
  // exact same threshold the composer already uses at creation time. 'done'
  // fires once hasRecipientsLeftToActOn says no -- see that function's own
  // comment for why 'opened' rows (an unanswered "did that send?") keep a
  // campaign OUT of 'done', and why an unreachable customer stuck at
  // 'waiting' forever must not.
  //
  // CRITICAL: 'done' is NOT a one-way door. There used to be an
  // `if (current === 'done') return;` guard here that made it one -- but
  // hasRecipientsLeftToActOn deliberately ignores unreachable 'waiting' rows
  // (see its own comment), so 'done' can be written while phone-less
  // recipients still sit in the queue. campaigns-tab.tsx's unreachable
  // caveat promises "fix a number and they join the queue automatically",
  // and that promise is only true if a fixed number can flip status back to
  // 'sending' -- which requires this effect to keep running after 'done'.
  // Reopening only happens when there is real work again: a top-up
  // (syncRecipients, run every time this screen mounts) adds a newly-
  // matching customer, or a 'waiting' row's customer becomes reachable
  // between one open of this screen and the next. campaigns-tab.tsx's own
  // `canReopenDone` is the other half of this -- the button that gets an
  // owner back into this screen for a 'done' campaign in the first place.
  //
  // Guarded by a ref, not by re-reading `campaign.status` from props: the
  // parent only refreshes that on close (see campaigns-tab.tsx's onClose ->
  // reload()), so it would still read 'draft' on every recipients change
  // during this same session and re-fire the write every time. Best-effort on
  // failure -- every recipient write behind this already landed, so a status
  // write that fails once is a display lag the NEXT recipients change retries,
  // not a reason to block the queue over.
  const lastWrittenStatusRef = useRef<Campaign['status']>(campaign.status);
  useEffect(() => {
    if (!loaded || recipients.length === 0) return;
    const current = lastWrittenStatusRef.current;
    // 'sending' whenever there's real work, whatever `current` was --
    // 'draft' on first open, or 'done' reopened by a top-up. 'done'
    // otherwise. current === target is the only no-op case (including
    // 'done' staying 'done' when nothing changed), so this never re-fires
    // a write it already made.
    const target: Campaign['status'] = hasRecipientsLeftToActOn(recipients, customersById) ? 'sending' : 'done';
    if (target === current) return;
    lastWrittenStatusRef.current = target;
    updateCampaign(campaign.id, {
      status: target,
      ...(current === 'draft' && { startedAt: campaign.startedAt ?? new Date().toISOString() }),
    }).catch(() => {
      lastWrittenStatusRef.current = current;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, recipients, customersById, campaign.id]);

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

  // A mount-time snapshot, not a live clock -- calling Date.now() straight in
  // a render body is impure (react-hooks/purity), same tradeoff
  // campaign-composer.tsx's own `now` makes for its list of live promotions.
  // This still catches every case CRITICAL 1 describes (a queue opened days
  // after its offer ended, archived, or paused) -- those are all already-
  // stale by the time this screen opens, not a promotion dying in the exact
  // seconds this one sheet happens to stay on screen. `promotion === null` is
  // deliberately NOT an issue here: it means either a campaign genuinely
  // built with no discount (legitimate, must still send -- see
  // campaign-composer.tsx's "Just a message, no discount") or one whose
  // promotion was hard-deleted, which this table's own on-delete-set-null
  // makes indistinguishable from the first case after the fact. Blocking
  // every promotion-less campaign to catch the rare second case would break
  // the common, legitimate first one.
  const [now] = useState(() => Date.now());
  const promotionIssue = promotion ? promotionLiveIssue(promotion, now) : null;

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

  // Declared above the effect that calls it, not below: React Compiler is
  // enabled (app.json experiments.reactCompiler) and reads a function used
  // before its declaration as a violation, which bails the whole component
  // out of optimisation.
  async function handleAnswer(id: string, outcome: TriChoiceAnswer) {
    if (outcome === 'dismiss') {
      // Nothing was answered -- the row stays exactly as it is: 'opened',
      // opened_at intact, re-askable later via `reaskAbout`. This is the
      // fix for the mis-tap that used to silently write 'waiting' here
      // (Escape, an outside tap, the browser X, or Android's back button),
      // which put the recipient back in line to be messaged a second time.
      pendingIdRef.current = null;
      setAskingId(null);
      return;
    }
    const nextState: RecipientState = outcome === 'confirm' ? 'sent' : 'waiting';
    setBusy(true);
    setError(null);
    try {
      await setRecipientState(id, nextState);
      // A 'deny' answer retracts the open -- opened_at goes with it (see the
      // identical fix in setRecipientState) so the local copy of the row
      // doesn't say 'waiting' while still claiming a chat was opened.
      patchRecipient(
        id,
        outcome === 'confirm' ? { state: nextState, sentAt: new Date().toISOString() } : { state: nextState, openedAt: null }
      );
    } catch (err) {
      // Surfaced in the sheet, which by now is the only thing on screen --
      // the Alert has already closed by the time this runs, so there is no
      // second surface it could be hiding behind. The row itself is left at
      // 'opened' rather than silently advanced, which is exactly what makes
      // it re-askable via `reaskAbout` above.
      setError(extractErrorMessage(err, 'Could not save your answer -- this person is still marked "chat opened", tap them below to try again.'));
    } finally {
      setBusy(false);
      pendingIdRef.current = null;
      setAskingId(null);
    }
  }

  // Asks the "did that send?" question via a native Alert (confirmTriChoice)
  // rather than a second AppModal. This codebase already documents that iOS
  // silently drops a modal presented while another is still up -- see the
  // staged-receipt comment in pos.tsx -- and the queue sheet below is always
  // an open AppModal while this question needs asking. Alert presents from
  // the topmost presented view controller instead of the root, so it works
  // over an open sheet where a second AppModal would not.
  //
  // confirmTriChoice, not confirmChoice: this question backs a WRITE that can
  // re-message someone (a real "No" reverts them to 'waiting'), so a mis-tap
  // or an accidental dismissal must not be able to trigger it -- see
  // confirm.ts's own comment on the distinction.
  //
  // NATIVE ONLY. `confirmTriChoice`'s web branch goes through
  // `window.confirm`, which has exactly two outcomes (OK/Cancel) and folds
  // the negative one into 'dismiss' -- correctly, since a browser can't tell
  // "clicked Cancel" from "hit Escape" apart. But that leaves 'deny'
  // permanently unreachable on web: an owner who genuinely did NOT send
  // could never say so, the recipient would sit at 'opened' forever, and
  // (per hasRecipientsLeftToActOn) the campaign could never reach 'done' on
  // this platform. The card rendered below when `askingId && Platform.OS ===
  // 'web'` is the fix -- real, separately-labelled buttons for all three
  // outcomes, in-sheet rather than in a browser dialog this codebase has no
  // control over. Its copy is exactly the button labels shown, not a
  // description of buttons that don't exist.
  //
  // Fires only when `askingId` itself changes -- not on every re-render --
  // so recipients/customersById can be read straight from the render closure
  // without listing them as deps and risking a duplicate Alert firing if
  // unrelated state changes while one is already on screen.
  useEffect(() => {
    if (!askingId || Platform.OS === 'web') return;
    const id = askingId;
    const customer = askingCustomer;
    let cancelled = false;
    (async () => {
      const title = `Did that send${customer ? ` to ${customer.firstName}` : ''}?`;
      const outcome = await confirmTriChoice(
        title,
        'Tap "Yes, sent" if you sent it in WhatsApp, or "No, not sent" to keep them in the queue and try again.',
        'Yes, sent',
        'No, not sent'
      );
      if (cancelled) return;
      await handleAnswer(id, outcome);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askingId]);

  // Lets an 'opened' row be answered later instead of staying stuck forever:
  // an owner whose phone died mid-flow, or who just never got asked, can tap
  // the row itself to raise the same question again. Ignored while a
  // question is already up or a save is in flight, so two Alerts can never
  // stack.
  function reaskAbout(id: string) {
    if (askingId || busy) return;
    pendingIdRef.current = id;
    setAskingId(id);
  }

  const counts = countRecipients(recipients);
  // Persisted total, not a local tally -- see the comment on
  // SENT_BREAK_INTERVAL for why the trigger has to be the server's count.
  // Worded "in total" rather than "this run" so reopening a queue with 40
  // already sent doesn't claim 40 just happened.
  const showBreakCaveat = counts.markedSent > 0 && counts.markedSent % SENT_BREAK_INTERVAL === 0;

  // IMPORTANT: checked FRESH, with the actual clock, not the mount-time
  // `promotionIssue` above. A session can sit open across the offer's end --
  // typically midnight, an owner opens the queue at 11pm and is still
  // working through it after the offer has ended -- and `promotionIssue`
  // only ever reflects the instant this screen was mounted. `promotionIssue`
  // is still what gates the render below (belt-and-braces, and it's what the
  // caveat card's own wording is drawn from), but it is not what gates the
  // WRITE.
  //
  // `promotionLiveIssue(promotion)` called with ONE argument, not two:
  // `promotionLiveIssue` defaults its clock to `Date.now()` inside
  // discounts.ts (see its signature), so the impure call happens there,
  // outside this component, and this line reads clean under
  // react-hooks/purity -- unlike an inline `Date.now()` here, which the
  // compiler rejects. This is a real fresh check, not a second read of the
  // same stale `now`.
  async function handleOpenWhatsApp() {
    if (!current || !currentCustomer || !currentCustomer.phone || !messageTemplate) return;
    const freshIssue = promotion ? promotionLiveIssue(promotion) : null;
    if (freshIssue) {
      setError(`${freshIssue} This campaign can no longer send — nobody here will be messaged until it's rebuilt with a different offer.`);
      return;
    }
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

  // The "did that send?" question is asked via confirmTriChoice (an OS Alert),
  // not a second AppModal -- see the comment on the confirm effect above for
  // why. This is the only AppModal SendQueue ever renders.
  return (
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
                ) : promotionIssue ? (
                  <Caveat tone="wrong">{`${promotionIssue} This campaign can no longer send — nobody here will be messaged until it's rebuilt with a different offer.`}</Caveat>
                ) : askingId && Platform.OS === 'web' ? (
                  // Web's answer to the native Alert above -- see the
                  // comment on the confirm effect for why window.confirm
                  // can't be used for this question. Three real, separately
                  // labelled buttons, so the copy always matches what's
                  // actually on screen. Replaces the "current" card rather
                  // than sitting alongside it: the native Alert blocks
                  // interaction with everything behind it too, and this is
                  // the in-sheet equivalent of that -- the owner must answer
                  // before moving on.
                  <BentoCard>
                    <Text style={styles.currentName}>{`Did that send${askingCustomer ? ` to ${askingCustomer.firstName}` : ''}?`}</Text>
                    <Text style={styles.currentMeta}>WhatsApp opened for them a moment ago — what actually happened?</Text>
                    <Pressable
                      disabled={busy}
                      onPress={() => handleAnswer(askingId, 'confirm')}
                      accessibilityRole="button"
                      style={[styles.primary, busy && styles.actionOff]}
                    >
                      <Text style={styles.primaryText}>Yes, sent</Text>
                    </Pressable>
                    <View style={styles.secondaryRow}>
                      <Pressable
                        disabled={busy}
                        onPress={() => handleAnswer(askingId, 'deny')}
                        accessibilityRole="button"
                        style={[styles.secondary, styles.secondaryHalf, busy && styles.actionOff]}
                      >
                        <Text style={styles.secondaryText}>No, not sent</Text>
                      </Pressable>
                      <Pressable
                        disabled={busy}
                        onPress={() => handleAnswer(askingId, 'dismiss')}
                        accessibilityRole="button"
                        style={[styles.secondary, styles.secondaryHalf, busy && styles.actionOff]}
                      >
                        <Text style={styles.secondaryText}>Ask me later</Text>
                      </Pressable>
                    </View>
                  </BentoCard>
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
                    {`${counts.markedSent} marked sent in total — WhatsApp can rate-limit or ban a number that messages many people in a burst. Worth a short break before the next one.`}
                  </Caveat>
                )}

                <BentoCard title="Queue" bodyStyle={styles.queueBody}>
                  {ordered.length === 0 ? (
                    <Text style={styles.empty}>Nobody matches this audience yet.</Text>
                  ) : (
                    ordered.map((r) => {
                      const customer = customersById.get(r.customerId);
                      const status = recipientStatus(r, customer);
                      // Only an 'opened' row is re-askable -- tapping any
                      // other state does nothing, so it's left visually and
                      // functionally inert for those.
                      const reaskable = r.state === 'opened';
                      return (
                        <Pressable
                          key={r.id}
                          disabled={!reaskable || askingId !== null || busy}
                          onPress={() => reaskAbout(r.id)}
                          // Announced as a button only when it IS one. A row
                          // for a sent or skipped recipient is a line of
                          // record, and calling it a button would promise a
                          // screen-reader user an action that does nothing.
                          accessibilityRole={reaskable ? 'button' : undefined}
                          accessibilityHint={reaskable ? 'Asks again whether this message was sent' : undefined}
                          // The badge already reads "chat opened -- send?", but
                          // nothing said the row could be tapped to answer it,
                          // and this is the only route back from an
                          // unanswered question.
                          style={({ pressed }) => [styles.queueRow, reaskable && styles.queueRowReaskable, pressed && reaskable && styles.queueRowPressed]}
                        >
                          <View style={styles.queueMain}>
                            <Text style={styles.queueName} numberOfLines={1}>
                              {customer ? customerDisplayName(customer) : 'Unknown customer'}
                            </Text>
                            {/* Two customers can share a name -- the number tells them apart. */}
                            <Text style={styles.queuePhone} numberOfLines={1}>
                              {customer?.phone ?? 'no phone on file'}
                            </Text>
                          </View>
                          <Badge variant="bento" label={status.label} tone={status.tone} />
                        </Pressable>
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
  // A row that can be tapped to re-ask reads slightly forward of the inert
  // ones -- the badge said the question was unanswered, nothing said the row
  // was the way to answer it.
  queueRowReaskable: { backgroundColor: theme.bentoSoft, borderRadius: 10 },
  queueRowPressed: { opacity: 0.6 },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoLine,
  },
  queueMain: { flex: 1, minWidth: 0 },
  queueName: { fontSize: 13, fontWeight: '600', color: theme.bentoInk },
  queuePhone: { fontSize: 11, color: theme.bentoMuted, marginTop: 1 },
});
