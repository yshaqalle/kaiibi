import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { StorefrontView } from '@/components/storefront/storefront-view';
import { getPublicDeliveryAreas, getPublicStorefront, getPublicStorefrontProducts } from '@/lib/storefront';
import type { PublicDeliveryArea, PublicStorefront, StorefrontProduct } from '@/types/models';

// A DRAFT SHOP AND A NONEXISTENT SHOP RENDER THE SAME PAGE.
//
// Not a nicety. If "not published yet" were distinguishable from "no such shop",
// the subdomain becomes an oracle: anyone could walk names and learn which shops
// are on kaiibi, and what they are called, before they have opened. One page, one
// message, no leak. The read path returns no row for either case, so this screen
// cannot tell them apart even if a future edit wanted it to.
export default function StorefrontScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'missing' }
    | { status: 'ready'; shop: PublicStorefront; products: StorefrontProduct[]; areas: PublicDeliveryArea[] }
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
        const [products, areas] = await Promise.all([
          getPublicStorefrontProducts(String(slug)),
          shop.offersDelivery ? getPublicDeliveryAreas(String(slug)) : Promise.resolve([]),
        ]);
        if (!cancelled) setState({ status: 'ready', shop, products, areas });
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

  if (state.status === 'loading') {
    return (
      <View style={styles.centre}>
        <ActivityIndicator />
      </View>
    );
  }

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
      <StorefrontView storefront={state.shop} products={state.products} areas={state.areas} />
    </>
  );
}

// Rendered only from the `ready` branch above -- never from `loading` or
// `missing`. A title or description carrying the shop's name on the missing
// page would leak exactly what that page exists to hide (see the note at the
// top of this file), so this component must never be reachable from there.
function StorefrontHead({ shop }: { shop: PublicStorefront }) {
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
