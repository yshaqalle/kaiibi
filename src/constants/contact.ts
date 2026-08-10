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
 * FULLY QUALIFIED (`+252…`): every caller resolves numbers through the one
 * helper in `lib/whatsapp.ts` (`platform.ts` re-exports it), which does more
 * than strip non-digits — it swaps a leading 0 for 252 and assumes 252 for
 * anything nine digits or shorter. A qualified number is the only form none of
 * that guessing applies to.
 */
export const SUPPORT_WHATSAPP: string | null = null;
