import { openExternalUrl } from '@/lib/external-url';
import { toE164 } from '@/lib/phone-e164';

// wa.me only accepts digits. Somaliland numbers are written locally as
// 063 xxx xxxx, so a leading 0 is dropped and the 252 country code assumed
// when none is given -- otherwise every link would silently open an empty chat.
// The strict half of that -- what counts as a dialable number at all -- lives
// once in toE164 (phone-e164.ts); this is the one place that turns a
// normalised number into a wa.me link, for loose caller input and already-
// normalised E.164 alike (see waLink in storefront.ts, which is this
// function under an older name kept for its own callers).
//
// This normalization started life in platform.ts for the operator portal's
// "message this shop" button; it lives here now so customers, staff and
// receipts resolve numbers the same way rather than each getting their own
// idea of what a phone number looks like. platform.ts re-exports it.
//
// toE164 refuses a bare-digit number that's too long to be a local subscriber
// and carries no + or 00 to prove it's already international -- the right
// call for a value about to be STORED (see phone-e164.ts): guessing wrong
// there mints a real number belonging to a stranger. A link is not storage.
// The shopkeeper already typed a whole number, digits and all, so the safer
// answer here is to use it exactly as typed rather than refuse to link it at
// all -- this is main's original behaviour for that one shape, restored
// after toE164 (rightly) stopped guessing a 252 prefix onto it. Every other
// null from toE164 (too short, an explicit but malformed international
// claim) stays refused, unchanged.
function bareForeignDigits(phone: string): string | null {
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) return null; // toE164 already handles an explicit +
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  // A leading 00 or a trunk 0 both make a claim toE164 already checks and,
  // when malformed, deliberately refuses rather than repairs -- this is not
  // that case, so it is left alone rather than second-guessed here.
  if (digits.startsWith('0')) return null;
  // "Long enough to carry its own country code": a bare local subscriber
  // number (9 digits or fewer) is toE164's to prefix with 252, not this
  // function's to pass through unprefixed. E.164 allows 15 digits maximum.
  if (digits.length <= 9 || digits.length > 15) return null;
  return digits;
}

export function whatsappLink(phone: string | null | undefined, message?: string): string | null {
  if (!phone) return null;
  const e164 = toE164(phone);
  const digits = e164 ? e164.slice(1) : bareForeignDigits(phone);
  if (!digits) return null;
  return `https://wa.me/${digits}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

// Opens a chat, falling back to WhatsApp's own contact picker with the message
// already written when the number is unusable. That fallback is the point for
// receipt sharing, where a sale often has no customer phone at all and handing
// the merchant a prefilled draft to address themselves still does the job.
//
// Callers that render an affordance (a WhatsApp button) should ask
// whatsappLink() instead and hide themselves when it returns null -- offering
// to message someone whose number can't be dialled is a worse answer than not
// offering.
export function openWhatsApp(phone: string, text?: string): void {
  const link = whatsappLink(phone, text) ?? `https://wa.me/${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  openExternalUrl(link);
}
