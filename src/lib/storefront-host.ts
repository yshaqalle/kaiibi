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

const APP_DOMAIN = 'kaiibi.com';

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
