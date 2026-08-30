import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking } from 'react-native';

import { PublicOrderView } from '@/components/storefront/public-order-view';
import { confirmPublicOrder, getPublicOrder, type PublicOrder } from '@/lib/public-order';

// THE CUSTOMER'S ORDER PAGE. No login, no session, no shop context -- the
// token in the URL is the whole of their authority.
//
// The directory name IS the URL segment (Expo Router is file-based), and it
// comes from ORDER_SEGMENT: storefront-canonical-path.test.tsx resolves the
// path orderPath() builds to this exact file on disk rather than comparing
// the constant to itself. That is the assertion #108 wishes it had had.
//
// This file owns the fetch, the token and opening WhatsApp; PublicOrderView
// owns what is on screen. That split is why every state below is testable
// without expo-router or a network fake.
//
// `vercel.json` already rewrites every path to the SPA, so no hosting change
// was needed. `app.json` has scheme `kaiibi` but no associatedDomains, so this
// opens the WEB page rather than deep-linking into an app the customer has
// never installed -- which is what we want.
export default function PublicOrderRoute() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const value = Array.isArray(token) ? token[0] : token;

  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);

    getPublicOrder(String(value ?? ''))
      .then((result) => {
        if (cancelled) return;
        // null is the server's ONE answer for unknown, expired and mistyped.
        // It is a state, not a failure, and it must not be reported as one.
        if (!result) setNotFound(true);
        else setOrder(result);
      })
      .catch(() => {
        if (cancelled) return;
        // A REQUEST that failed is a different thing to tell a customer than
        // "this link is not valid" -- one sends them to check their signal,
        // the other to phone the shop about a link that is perfectly good.
        setError('Could not load this order.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  const onConfirm = useCallback(() => {
    setConfirming(true);
    confirmPublicOrder(String(value ?? ''))
      .then((result) => {
        // The RPC returns the SAME projection the read does, so the agreement
        // renders from this response rather than costing a second request.
        if (result) setOrder(result);
      })
      .catch(() => setError('Could not send your reply.'))
      .finally(() => setConfirming(false));
  }, [value]);

  // WRITES NOTHING, and there is deliberately no RPC behind it. A link that
  // has been forwarded, screenshotted or leaked must never be able to alter an
  // order, so "something's wrong" stays in the human channel -- where the shop
  // can ask who it is talking to. See confirm_public_order's own header.
  const onMessageShop = useCallback(() => {
    if (!order) return;
    const text = `Hello ${order.shopName}, I have a question about order #${order.number}.`;
    Linking.openURL(`https://wa.me/?text=${encodeURIComponent(text)}`).catch(() => {
      // A device with no WhatsApp is not an error worth a screen: the page
      // still shows the order, which is what they came for.
    });
  }, [order]);

  return (
    <PublicOrderView
      order={order}
      loading={loading}
      notFound={notFound}
      error={error}
      confirming={confirming}
      onConfirm={onConfirm}
      onMessageShop={onMessageShop}
    />
  );
}
