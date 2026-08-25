import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { StorefrontView } from '@/components/storefront/storefront-view';
import { getPublicStorefront, getPublicStorefrontProducts } from '@/lib/storefront';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

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
    { status: 'loading' } | { status: 'missing' } | { status: 'ready'; shop: PublicStorefront; products: StorefrontProduct[] }
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
        const products = await getPublicStorefrontProducts(String(slug));
        if (!cancelled) setState({ status: 'ready', shop, products });
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

  return <StorefrontView storefront={state.shop} products={state.products} />;
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#ffffff' },
  mark: { fontSize: 12, fontWeight: '800', letterSpacing: 2, color: '#9a9aa2' },
  title: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, marginTop: 12, textAlign: 'center' },
  body: { fontSize: 13.5, color: '#5e5d65', marginTop: 6, textAlign: 'center' },
});
