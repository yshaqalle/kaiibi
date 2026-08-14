import { isReachable } from '@/lib/campaign-audience';
import type { CampaignRecipient, Customer } from '@/types/models';

// Every figure a campaign shows, and where each one comes from.
//
// The tempting metric here is "opened", meaning the CUSTOMER opened it, and it
// is unavailable: a wa.me link is a one-way door with no callback and no
// return value. So this file counts two kinds of thing and nothing else --
// a tap the owner made, and a sale rung up under a customer's name.

export function countRecipients(recipients: readonly CampaignRecipient[]) {
  const counts = { audience: recipients.length, markedSent: 0, opened: 0, skipped: 0, unreachable: 0 };
  for (const recipient of recipients) {
    if (recipient.state === 'sent') counts.markedSent++;
    // 'opened' is strictly weaker than 'sent': the app handed the chat over
    // with the text written, and the owner never confirmed what happened next.
    else if (recipient.state === 'opened') counts.opened++;
    else if (recipient.state === 'skipped') counts.skipped++;
    else if (recipient.state === 'unreachable') counts.unreachable++;
  }
  return counts;
}

// Everyone the queue has already dealt with, whatever the outcome -- skipped
// and explicitly-unreachable both count as "worked through" for pacing
// purposes even though neither is progress toward a message actually going
// out. The one shared source for this so campaigns-tab.tsx's list-row chip
// and its detail-pane chip/tiles/button can never say two different numbers
// for the same campaign.
export function recipientsProcessed(recipients: readonly CampaignRecipient[]): number {
  const counts = countRecipients(recipients);
  return counts.markedSent + counts.opened + counts.skipped + counts.unreachable;
}

// How many of THIS campaign's own recipient rows belong to a customer
// WhatsApp can currently reach -- the denominator for "processed of
// reachable", sourced from the rows a campaign actually materialised rather
// than from re-evaluating its audience filter live.
//
// The filter describes who to ADD (see syncRecipients in campaigns.ts); the
// rows are who is actually in it. A customer who stops matching the filter
// mid-campaign (they came back and bought, in a win-back campaign) keeps
// their row on purpose, and must keep counting here too -- re-deriving this
// from the filter instead is exactly what let the denominator shrink out
// from under a campaign that was working perfectly, mid-run.
export function reachableRecipientCount(recipients: readonly CampaignRecipient[], customersById: ReadonlyMap<string, Customer>): number {
  let count = 0;
  for (const recipient of recipients) {
    const customer = customersById.get(recipient.customerId);
    if (customer && isReachable(customer)) count++;
  }
  return count;
}

// Whether anyone in this campaign still needs the owner's attention.
// 'waiting' rows whose customer is reachable haven't been reached yet, in the
// exact sense send-queue.tsx's own `current` derivation uses; a customer with
// no usable number sits at 'waiting' forever (see the comment on `current` in
// send-queue.tsx for why that's never auto-resolved) and must not be counted
// here, or a campaign with even one unreachable customer could never reach
// 'done'. 'opened' counts as unfinished too, deliberately -- it is an
// unanswered question ("did that send?"), not a resolved outcome, and a
// campaign is not done while one is still open.
export function hasRecipientsLeftToActOn(recipients: readonly CampaignRecipient[], customersById: ReadonlyMap<string, Customer>): boolean {
  return recipients.some((r) => {
    if (r.state === 'opened') return true;
    if (r.state !== 'waiting') return false;
    const customer = customersById.get(r.customerId);
    return customer ? isReachable(customer) : false;
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Recipients who bought within `windowDays` of being messaged.
//
// The strongest number this feature has, because it never touches WhatsApp:
// it is a sale in this shop's own books, attached to a customer at the till.
// It is still a CORRELATION -- they may have been coming anyway, and a
// walk-in gets the same discount -- and the tile showing it must say so.
//
// Only 'sent' recipients count. For anyone else nothing was claimed to have
// reached them, so a purchase says nothing about the campaign.
//
// Deliberately takes no clock. Each recipient's window runs from THEIR OWN
// sentAt, so "now" never enters the arithmetic -- someone messaged an hour ago
// whose window is still open simply has not bought yet, and will be counted if
// they do. A `now` parameter here would look like it mattered and would be
// the kind of thing a later reader wires in by mistake.
export function boughtWithin(
  recipients: readonly CampaignRecipient[],
  salesByCustomer: ReadonlyMap<string, readonly string[]>,
  windowDays: number
): number {
  let count = 0;
  for (const recipient of recipients) {
    if (recipient.state !== 'sent' || !recipient.sentAt) continue;
    const sentAt = Date.parse(recipient.sentAt);
    const sales = salesByCustomer.get(recipient.customerId) ?? [];
    // `some`, not a tally: a customer who came back four times is one person
    // who responded, and counting visits would let one enthusiast look like
    // four.
    const responded = sales.some((iso) => {
      const at = Date.parse(iso);
      return at >= sentAt && at - sentAt <= windowDays * DAY_MS;
    });
    if (responded) count++;
  }
  return count;
}
