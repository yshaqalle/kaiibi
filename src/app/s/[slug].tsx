import { Redirect, useLocalSearchParams } from 'expo-router';

import { storefrontPath } from '@/lib/storefront-host';

// THE OLD ADDRESS. Kept, not deleted.
//
// `/s/<slug>` is the address every shop on kaiibi was actually given: the
// intended `<slug>.kaiibi.com` form never shipped, because no wildcard DNS
// record was ever created (docs/backlog/2026-08-27-storefront-wildcard-
// dns.md). So this is the link that is printed on cards, pasted into WhatsApp
// and forwarded on -- and a link like that is out of our hands the moment it
// is sent. Removing this file would 404 every one of them, and the shop would
// hear about it from the customer who tried.
//
// A REDIRECT, not a second copy of the screen. Rendering the storefront here
// as well would leave one page reachable at two addresses, which is how the
// two quietly drift apart -- and it would mean every future change to the
// storefront had to be made twice. It also means there is exactly one
// canonical address for a shop to be seen at, which is the point of the
// rename.
//
// `<Redirect>` rather than a post-mount `router.replace`: same reason
// _layout.tsx gives at length. A redirect resolved during the render pass
// never paints the wrong thing first.
export default function LegacyStorefrontRoute() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  return <Redirect href={storefrontPath(String(slug)) as never} />;
}
