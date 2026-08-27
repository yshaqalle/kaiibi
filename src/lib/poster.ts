import { formatCents } from '@/lib/currency';
import { instantToEndDateInput, instantToStartDateInput } from '@/lib/promotion-dates';
import type { Promotion, PromotionOfferFacts } from '@/types/models';

// Every word a poster prints, derived from records that already exist.
//
// The point of generating this rather than asking the owner to type it is that
// a poster then cannot contradict the till: if the offer says 20% and runs
// through Saturday, so does the paper on the door. The single free-text field
// is the headline, because "Ciid wanaagsan" is not derivable from a discount
// row.
export type PosterCopy = {
  headline: string | null;
  value: string;
  scope: string;
  when: string | null;
  shopName: string;
  branch: string | null;
  address: string | null;
  hours: string | null;
  phone: string | null;
  // The shop's own logo, already uploaded for receipt branding
  // (`shops.logoUrl`) -- there is nothing new for an owner to supply here,
  // just the same mark the till already prints.
  logoUrl: string | null;
};

export type PosterCopyInput = {
  promotion: Promotion;
  shopName: string;
  headline?: string | null;
  branch?: string | null;
  address?: string | null;
  hours?: string | null;
  phone?: string | null;
  logoUrl?: string | null;
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// 'YYYY-MM-DD' -> "Saturday 16 August". Built from the parts rather than
// toLocaleDateString: the poster's wording has to be identical on every device
// regardless of the phone's locale, because the shop is printing one sheet.
function longDate(dateInput: string): string {
  const [year, month, day] = dateInput.split('-').map(Number);
  const at = new Date(year, month - 1, day);
  return `${DAYS[at.getDay()]} ${day} ${MONTHS[month - 1]}`;
}

// Same, minus the month -- for the left half of a range that ends in the same
// month, so "Friday 14 — Sunday 16 August" rather than saying August twice.
function shortDate(dateInput: string): string {
  const [year, month, day] = dateInput.split('-').map(Number);
  const at = new Date(year, month - 1, day);
  return `${DAYS[at.getDay()]} ${day}`;
}

function windowLine(promotion: PromotionOfferFacts): string | null {
  const from = promotion.startsAt ? instantToStartDateInput(promotion.startsAt) : null;
  // Stored exclusive, printed inclusive: an offer stored as ending at midnight
  // on the 17th ran through the whole of the 16th, and the 16th is what a
  // customer standing in front of the sheet needs to read.
  const to = promotion.endsAt ? instantToEndDateInput(promotion.endsAt) : null;

  if (!from && !to) return null;
  if (from && !to) return `From ${longDate(from)}`;
  if (!from && to) return `Until ${longDate(to)}`;

  const sameMonth = from!.slice(0, 7) === to!.slice(0, 7);
  return `${sameMonth ? shortDate(from!) : longDate(from!)} — ${longDate(to!)}`;
}

function scopeLine(promotion: PromotionOfferFacts): string {
  if (promotion.scope === 'category' && promotion.scopeValue) return `All ${promotion.scopeValue}`;
  if (promotion.scope === 'brand' && promotion.scopeValue) return `Anything by ${promotion.scopeValue}`;
  return 'Everything in store';
}

// The three lines an offer is entitled to claim, derived from the promotion
// row and from nothing else.
//
// THIS IS THE ONE PLACE THE WORDING LIVES, and it has to stay that way. The
// printed poster (posterCopyFor, below) and the shop's public page
// (src/components/storefront/flyer-carousel.tsx, reading the raw facts
// get_public_storefront hands back) both come through here, so the paper on
// the door and the page at the shop's address cannot read two ways about one
// offer. This used to be a second, hand-ported copy in SQL --
// 20260930000100_public_storefront_flyers.sql -- kept honest only by a
// database check that re-asserted poster.test.ts's cases against it. That
// check was a guard around the duplication; deleting the duplication is the
// fix, and 20260930000300_flyer_offer_facts.sql is where it went.
//
// WHAT DID *NOT* MOVE: whether an offer is running at all. That stays in SQL
// (promotion_is_live), decided by the server before a flyer is ever handed to
// a client. An expired offer's words are never rendered here because the
// flyer carrying them never arrives. Only the WORDING is a client's job.
export type OfferCopy = Pick<PosterCopy, 'value' | 'scope' | 'when'>;

export function offerCopyFor(promotion: PromotionOfferFacts): OfferCopy {
  return {
    // formatCents (src/lib/currency.ts), never a hand-rolled '$' -- the same
    // formatter the till and the receipt use.
    value: promotion.discountType === 'percentage' ? `${promotion.discountValue}%` : formatCents(promotion.discountValue),
    scope: scopeLine(promotion),
    when: windowLine(promotion),
  };
}

export function posterCopyFor(input: PosterCopyInput): PosterCopy {
  const headline = input.headline?.trim();
  return {
    headline: headline ? headline : null,
    // Delegated, not duplicated: a poster and a public page derive one offer
    // through one function, so neither can drift from the other.
    ...offerCopyFor(input.promotion),
    shopName: input.shopName,
    branch: input.branch ?? null,
    address: input.address ?? null,
    hours: input.hours ?? null,
    phone: input.phone ?? null,
    logoUrl: input.logoUrl ?? null,
  };
}
