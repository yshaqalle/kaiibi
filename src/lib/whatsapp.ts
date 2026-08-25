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
export function whatsappLink(phone: string | null | undefined, message?: string): string | null {
  if (!phone) return null;
  const e164 = toE164(phone);
  if (!e164) return null;
  const digits = e164.slice(1);
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
