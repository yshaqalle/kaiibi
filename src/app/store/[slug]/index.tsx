import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import Head from 'expo-router/head';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { StorefrontSkeleton } from '@/components/storefront/storefront-skeleton';
import { type ShopTabKey } from '@/components/storefront/shop-tabs';
import { StorefrontView } from '@/components/storefront/storefront-view';
import { storefrontTabPath } from '@/lib/storefront-host';
import {
  getPublicDeliveryAreas, getPublicStorefront, getPublicStorefrontCategories, getPublicStorefrontProducts,
} from '@/lib/storefront';
import type {
  PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct,
} from '@/types/models';

// A DRAFT SHOP AND A NONEXISTENT SHOP RENDER THE SAME PAGE.
//
// Not a nicety. If "not published yet" were distinguishable from "no such shop",
// the subdomain becomes an oracle: anyone could walk names and learn which shops
// are on kaiibi, and what they are called, before they have opened. One page, one
// message, no leak. The read path returns no row for either case, so this screen
// cannot tell them apart even if a future edit wanted it to.
// Shared by both route files: /store/<slug> and /store/<slug>/<tab>. The only
// difference between them is which tab they open on, so the page itself is one
// component and the routes are two lines each.
export function StorefrontScreen({ tab = 'shop' }: { tab?: ShopTabKey }) {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'missing' }
    | {
        status: 'ready';
        shop: PublicStorefront;
        products: StorefrontProduct[];
        areas: PublicDeliveryArea[];
        categories: StorefrontCategory[];
      }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const shop = await getPublicStorefront(String(slug));
        if (cancelled) return;
        if (!shop) {
          setState({ status: 'missing' });
          return;
        }
        // Areas are only read when the shop actually offers delivery -- a
        // shop that doesn't has none to show and checkout (Task 6) already
        // treats an empty list the same as collection-only, so there is
        // nothing to gain from asking every collection-only shop's page load
        // to also pay for this RPC.
        //
        // B3: `.catch(() => [])` on this one call, not the whole Promise.all.
        // products and the shop read above are essential -- without them
        // there is no page -- but areas are not: this file's own comment two
        // lines up already says an empty list reads identically to
        // collection-only, so a blip on THIS read must fall back to that,
        // not drag a published, working shop down to the same "no shop at
        // this address" page an unknown slug gets. Left un-caught, a reject
        // here would still propagate through Promise.all into the outer
        // catch below and do exactly that.
        // `.catch(() => [])` on categories for the same reason it is on
        // areas, one line down: the band is a NAVIGATION AID over a grid
        // that is already on screen, so a blip on this read costs a
        // shortcut. Letting it reject would drag a published, working shop
        // down to the "no shop at this address" page.
        const [products, areas, categories] = await Promise.all([
          getPublicStorefrontProducts(String(slug)),
          shop.offersDelivery ? getPublicDeliveryAreas(String(slug)).catch(() => []) : Promise.resolve([]),
          getPublicStorefrontCategories(String(slug)).catch(() => []),
        ]);
        if (!cancelled) setState({ status: 'ready', shop, products, areas, categories });
      } catch {
        // A failed read is indistinguishable from an unknown shop on purpose --
        // an error page would confirm the shop exists.
        if (!cancelled) setState({ status: 'missing' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // A spinner on white said nothing about whose page was loading or what
  // shape it would be -- and this is the slowest moment in the whole flow.
  // See storefront-skeleton.tsx on why it is neutral rather than in the
  // shop's palette: the palette arrives with the fetch this is waiting on.
  if (state.status === 'loading') return <StorefrontSkeleton />;

  if (state.status === 'missing') {
    return (
      <View style={styles.centre}>
        <Text style={styles.mark}>KAIIBI</Text>
        <Text style={styles.title}>There&apos;s no shop at this address.</Text>
        <Text style={styles.body}>Check the spelling, or ask the shop for their link.</Text>
      </View>
    );
  }

  return (
    <>
      <StorefrontHead shop={state.shop} />
      <StorefrontView
        storefront={state.shop}
        products={state.products}
        areas={state.areas}
        categories={state.categories}
        tab={tab}
        // REPLACE, never push. A tab is a view of the same page, not a step in
        // a journey: pushing would make the device's back button walk back
        // through every tab the customer glanced at before it finally left the
        // shop, which is the behaviour that makes people give up and close the
        // tab instead.
        onSelectTab={(next: ShopTabKey) => {
          // `as Href`: typedRoutes generates a union of literal paths and
          // cannot see through storefrontTabPath, which is exactly where the
          // rule about this address living in one place is enforced. Casting
          // here keeps that helper the single source rather than inlining a
          // template literal the compiler happens to accept.
          router.replace(storefrontTabPath(String(slug), next) as Href);
        }}
      />
    </>
  );
}

// Rendered only from the `ready` branch above -- never from `loading` or
// `missing`. A title or description carrying the shop's name on the missing
// page would leak exactly what that page exists to hide (see the note at the
// top of this file), so this component must never be reachable from there.
//
// WEB ONLY, AND ON iOS THAT IS A CRASH FIX RATHER THAN A TIDY-UP.
//
// `expo-router/head` is two different components behind one import. On web it
// emits real <head> elements, which is the entire reason this exists: a title,
// a description and the og: tags a forwarded WhatsApp link renders its preview
// card from. On iOS it resolves to ExpoHead.ios.js, which implements Apple
// HANDOFF instead -- publishing the route as an NSUserActivity so it can be
// picked up in Safari or on another device.
//
// To build the activity's URL it calls getStaticUrlFromExpoRouter(), which
// needs the `origin` option on the expo-router config plugin. app.json
// registers the plugin bare, so that call THROWS -- during render, inside
// <FocusedHead />, which takes the whole route down. The storefront has not
// rendered in the iOS app since this component landed (5c9b736, 2026-08-29);
// it went unseen because this is the one file in the codebase importing
// expo-router/head, it is a public page opened in browsers rather than in the
// app, and storefront-route.test.tsx mocks Head, so jest never runs the iOS
// implementation.
//
// Gated rather than fixed with an `origin`: adding one needs a native rebuild
// and switches on a handoff feature nobody asked for -- handing a shop page
// off to Safari is meaningless for a shop the app's own user does not own.
// Every tag below is a web concern, so web is where they belong.
function StorefrontHead({ shop }: { shop: PublicStorefront }) {
  if (Platform.OS !== 'web') return null;

  const title = shop.city ? `${shop.shopName} — ${shop.city}` : shop.shopName;
  const description = shop.headline ?? shop.about ?? `${shop.shopName} on Kaiibi.`;

  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content="website" />
      {shop.heroImageUrl ? <meta property="og:image" content={shop.heroImageUrl} /> : null}
    </Head>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#ffffff' },
  mark: { fontSize: 12, fontWeight: '800', letterSpacing: 2, color: '#9a9aa2' },
  title: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, marginTop: 12, textAlign: 'center' },
  body: { fontSize: 13.5, color: '#5e5d65', marginTop: 6, textAlign: 'center' },
});

// `/store/<slug>` -- the shop, on its Shop tab. The address every forwarded
// link and printed card already carries, unchanged.
export default function StorefrontIndexRoute() {
  return <StorefrontScreen tab="shop" />;
}
