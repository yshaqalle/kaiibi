import { openExternalUrl } from '@/lib/external-url';

// wa.me only accepts digits. Somaliland numbers are written locally as
// 063 xxx xxxx, so a leading 0 is dropped and the 252 country code assumed
// when none is given -- otherwise every link would silently open an empty chat.
//
// This normalization started life in platform.ts for the operator portal's
// "message this shop" button; it lives here now so customers, staff and
// receipts resolve numbers the same way rather than each getting their own
// idea of what a phone number looks like. platform.ts re-exports it.
export function whatsappLink(phone: string | null | undefined, message?: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `252${digits.slice(1)}`;
  else if (!digits.startsWith('252') && digits.length <= 9) digits = `252${digits}`;
  if (digits.length < 9) return null;
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
