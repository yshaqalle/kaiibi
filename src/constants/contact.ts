/**
 * How a visitor reaches us from a public page.
 *
 * One file so the landing page, the footer and the closing CTA cannot drift
 * apart, and so that supplying the support number later is a one-line change
 * rather than a hunt.
 */

/** Already published — it is the contact address in the privacy policy. */
export const SUPPORT_EMAIL = 'info@kaiibi.com';

/**
 * The support WhatsApp number, once there is one.
 *
 * There is no such number anywhere in the codebase today, so every contact CTA
 * falls back to email — see `supportHref` below. When you set this, write it
 * FULLY QUALIFIED (`+252…`): `lib/whatsapp.ts` only strips non-digits, while
 * `platform.ts`'s `whatsappLink` also expands the local `063…` convention, and
 * a qualified number means the two can never disagree.
 */
export const SUPPORT_WHATSAPP: string | null = null;
