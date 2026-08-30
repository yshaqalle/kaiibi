// Which shop -- if any -- this browser tab is asking for.
//
// Web ships as an SPA behind a catch-all rewrite (vercel.json), so every host
// serves the same bundle and the hostname is the only thing distinguishing
// `xamdi.kaiibi.com` from the app. This runs once at boot.
//
// Fails CLOSED: anything it does not positively recognise as `<label>.<domain>`
// returns null and the normal app loads. A localhost or preview host that
// resolved a shop would put a public storefront in front of a developer
// expecting the admin app, and worse, would do it on staging data.

import { validateSlug } from '@/lib/storefront-slug';

// Exported so the editor can SHOW the same address this function RESOLVES.
// They drifted once: the editor rendered `kaiibi.com/<slug>` while this only
// ever accepted `<slug>.kaiibi.com`, so a shopkeeper was shown an address that
// does not work -- on the one screen whose output gets printed on a card.
export const APP_DOMAIN = 'kaiibi.com';

// The URL segment a shop's page lives under: `/store/<slug>`.
//
// Expo Router is file-based, so this string is not free to say whatever it
// likes -- it has to be the name of the directory holding the route
// (`src/app/store/[slug].tsx`). Changing one without the other produces a
// build that redirects confidently to a page that does not exist, which is
// why storefront-canonical-path.test.tsx resolves this constant to a file on
// disk rather than merely comparing it to itself.
export const STOREFRONT_SEGMENT = 'store';

// The segment a CUSTOMER's own order lives under: `/o/<token>`.
//
// Short on purpose. This one gets read aloud over a phone and typed by hand,
// which is also why the token itself uses an alphabet with no i, l, o or u
// (see mint_order_share_token in the migration).
//
// Same file-based-routing constraint STOREFRONT_SEGMENT is under: this string
// has to be the name of the directory holding the route
// (`src/app/o/[token].tsx`), and storefront-canonical-path.test.tsx resolves
// it to that file on disk rather than comparing it to itself.
//
// THERE IS DELIBERATELY NO `LEGACY_ORDER_SEGMENT`, and its absence is under
// test. The storefront address kept its old segment alive as a redirect
// because "a link like that is out of our hands the moment it is sent"; the
// same is true of an order link, but no such promise is being made here (plan
// decision 3). If this segment ever changes, links already sitting in
// customers' WhatsApp histories 404 rather than redirecting. That is accepted
// -- and adding an unused legacy constant "just in case" is exactly how the
// next reader would conclude otherwise.
export const ORDER_SEGMENT = 'o';

// The segment shops were given BEFORE the rename, kept alive as a redirect.
//
// It is not dead weight and it is not a nicety: `<slug>.kaiibi.com` was never
// given a wildcard DNS record (docs/backlog/2026-08-27-storefront-wildcard-
// dns.md), so `/s/<slug>` is the only address that has ever actually worked in
// public. Every link a shop has printed on a card or sent on WhatsApp is one
// of these. Deleting `src/app/s/[slug].tsx` turns all of them into 404s.
export const LEGACY_STOREFRONT_SEGMENT = 's';

// The one place a public storefront path is built. Both redirects go through
// it -- the hostname one at app boot and the legacy-segment one -- so there is
// no second copy of the segment to drift from this file's own constant.
export function storefrontPath(slug: string): string {
  return `/${STOREFRONT_SEGMENT}/${slug}`;
}

// WHAT A SHOP IS TOLD ITS ADDRESS IS -- the one place it is built, for every
// surface that shows it, copies it or sends it.
//
// It is the PATH form, `kaiibi.com/store/<slug>`, because that is the form
// that resolves. `<slug>.kaiibi.com` was never given a wildcard DNS record
// (docs/backlog/2026-08-27-storefront-wildcard-dns.md); `dig +short
// xamdi.kaiibi.com` returns nothing to this day. The editor showed and copied
// that form anyway, so a shop that published, pressed Copy link and sent the
// result watched it fail DNS at the customer's end -- and had no way to tell
// that the address it had been handed was the problem. A long address that
// works beats a short one that does not.
//
// WHICH FORM IS CANONICAL LONG-TERM IS NOT DECIDED HERE. That is options
// A/B/C in the backlog doc above, deliberately deferred. This function is why
// that decision stays cheap: on the day a wildcard record (or a per-shop
// CNAME) exists, this body becomes `${slug}.${APP_DOMAIN}` and every surface
// follows from one edit. slugFromHostname below is untouched by that choice
// and stays working either way -- it is what serves the subdomain form the
// moment DNS makes it reachable.
export function storefrontAddress(slug: string): string {
  return `${APP_DOMAIN}${storefrontPath(slug)}`;
}

// The same address with the shop's own part left off -- what the editor puts
// in FRONT of the slug field while it is still being typed. Derived from
// storefrontAddress rather than written out, so a change to the form above
// cannot leave the field teaching an address the rest of the app no longer
// gives out.
export const STOREFRONT_ADDRESS_PREFIX = storefrontAddress('');

export function slugFromHostname(hostname: string, appDomain: string = APP_DOMAIN): string | null {
  if (typeof hostname !== 'string') return null;
  const host = hostname.trim().toLowerCase();
  const suffix = `.${appDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;

  const label = host.slice(0, -suffix.length);
  // Exactly one label. `a.b.kaiibi.com` is not a shop; guessing which half is
  // the slug is how you serve the wrong shop's prices.
  if (!label || label.includes('.')) return null;
  // The label is untrusted input from the network, not a value we minted. Run
  // it through the same rules a slug must pass to be written in the first
  // place (length, characters, edge hyphens, reserved names) so this function
  // never hands a caller something that merely looks dot-free. Fails closed:
  // an unparseable label behaves exactly like an unknown host.
  if (validateSlug(label) !== null) return null;
  return label;
}

// The path a customer's order link points at, and the address a shop copies.
//
// A pair, not two independent builders: `orderAddress` is `APP_DOMAIN` plus
// whatever `orderPath` says, so the two cannot drift and settling
// path-vs-subdomain later (docs/backlog/2026-08-27-storefront-wildcard-dns.md,
// options A/B/C) stays a one-file change. This is the storefrontPath /
// storefrontAddress pair above, for the other public URL this app hands out.
//
// encodeURIComponent because this is the single place an order URL is built.
// A token off gen_random_bytes through a fixed alphabet can never need it, so
// it is belt and braces -- but a URL builder that does not escape is a defect
// waiting for the first input that is not what it expected.
export function orderPath(token: string): string {
  return `/${ORDER_SEGMENT}/${encodeURIComponent(token)}`;
}

export function orderAddress(token: string): string {
  return `${APP_DOMAIN}${orderPath(token)}`;
}
