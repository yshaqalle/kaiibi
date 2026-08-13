import type { CampaignRecipient } from '@/types/models';

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
export function boughtWithin(
  recipients: readonly CampaignRecipient[],
  salesByCustomer: ReadonlyMap<string, readonly string[]>,
  windowDays: number,
  now: number = Date.now()
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
