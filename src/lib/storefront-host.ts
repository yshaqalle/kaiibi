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
