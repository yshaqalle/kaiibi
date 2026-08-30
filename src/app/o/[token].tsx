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
  // Expo Router hands a dynamic segment back as string | string[]. Narrowed
  // once, here, so nothing below has to think about it again.
  const { token: rawToken } = useLocalSearchParams<{ token: string }>();
  const token = String((Array.isArray(rawToken) ? rawToken[0] : rawToken) ?? '');

  // ONE state object, keyed by the token it describes, and NOTHING is set
  // synchronously inside the effect. Resetting loading/error/notFound at the
  // top of the effect is the obvious shape and it is what
  // react-hooks/set-state-in-effect refuses: those three setState calls run
  // during the render pass and trigger a second one before the fetch has even
  // started. Deriving `loading` from whether the loaded token matches the one
  // in the URL gives the same behaviour -- a token change shows Loading
  // immediately, never a stale order -- with no synchronous write at all.
  const [result, setResult] = useState<{
    token: string;
    order: PublicOrder | null;
    notFound: boolean;
    error: string | null;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const loading = result?.token !== token;

  useEffect(() => {
    let cancelled = false;

    getPublicOrder(token)
      .then((order) => {
        if (cancelled) return;
        // null is the server's ONE answer for unknown, expired and mistyped.
        // It is a state, not a failure, and must not be reported as one.
        setResult({ token, order, notFound: order === null, error: null });
      })
      .catch(() => {
        if (cancelled) return;
        // A REQUEST that failed is a different thing to tell a customer than
        // "this link is not valid" -- one sends them to check their signal,
        // the other to phone the shop about a link that is perfectly good.
        setResult({ token, order: null, notFound: false, error: 'Could not load this order.' });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const onConfirm = useCallback(() => {
    setConfirming(true);
    confirmPublicOrder(token)
      .then((order) => {
        // The RPC returns the SAME projection the read does, so the agreement
        // renders from this response rather than costing a second request.
        if (order) setResult({ token, order, notFound: false, error: null });
      })
      .catch(() =>
        setResult((prev) => ({ token, order: prev?.order ?? null, notFound: false, error: 'Could not send your reply.' }))
      )
      .finally(() => setConfirming(false));
  }, [token]);

  // WRITES NOTHING, and there is deliberately no RPC behind it. A link that
  // has been forwarded, screenshotted or leaked must never be able to alter an
  // order, so "something's wrong" stays in the human channel -- where the shop
  // can ask who it is talking to. See confirm_public_order's own header.
  const onMessageShop = useCallback(() => {
    const order = result?.order;
    if (!order) return;
    const text = `Hello ${order.shopName}, I have a question about order #${order.number}.`;
    Linking.openURL(`https://wa.me/?text=${encodeURIComponent(text)}`).catch(() => {
      // A device with no WhatsApp is not an error worth a screen: the page
      // still shows the order, which is what they came for.
    });
  }, [result]);

  return (
    <PublicOrderView
      order={result?.order ?? null}
      loading={loading}
      notFound={result?.notFound ?? false}
      error={result?.error ?? null}
      confirming={confirming}
      onConfirm={onConfirm}
      onMessageShop={onMessageShop}
    />
  );
}
