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
