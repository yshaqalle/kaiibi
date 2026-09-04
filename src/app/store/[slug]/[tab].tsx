import { useLocalSearchParams } from 'expo-router';

import { StorefrontScreen } from '@/app/store/[slug]/index';
import { SHOP_TAB_LABELS, type ShopTabKey } from '@/components/storefront/shop-tabs';

// `/store/<slug>/about` and `/store/<slug>/visit`.
//
// A TAB IS PART OF THE ADDRESS, which is the whole point of this file: a shop
// that wants to send somebody its story can send the story, not the shop page
// with an instruction to press a button. It also means the browser's back
// button does what a reader expects, and that a tab survives a refresh.
//
// Renders the same component /store/<slug> does. The tab is the only
// difference between them, so there is one page and two doors into it.
export default function StorefrontTabRoute() {
  const { tab } = useLocalSearchParams<{ tab: string }>();

  // An unknown tab renders the SHOP, rather than 404ing or rendering an empty
  // rail. `/store/xamdi/pricing` is a typo or an old link, and the useful
  // answer to both is the shop -- the same posture StorefrontView takes on an
  // unrecognised theme, and ShopChrome on a tab a shop no longer has.
  //
  // An own-property check, not `in`: a segment of 'constructor' or 'toString'
  // resolves through the prototype chain and would pass a truthiness test --
  // the same discipline storefront-view.tsx applies to RENDERERS.
  const known = Object.prototype.hasOwnProperty.call(SHOP_TAB_LABELS, String(tab));
  return <StorefrontScreen tab={known ? (String(tab) as ShopTabKey) : 'shop'} />;
}
