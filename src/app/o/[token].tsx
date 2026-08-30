import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

// THE CUSTOMER'S ORDER PAGE. No login, no session, no shop context.
//
// Created in Part 3 Task 1 alongside ORDER_SEGMENT, because the two are one
// fact: Expo Router is file-based, so `ORDER_SEGMENT = 'o'` is a claim that
// THIS DIRECTORY exists, and storefront-canonical-path.test.tsx resolves the
// built path to this file rather than comparing the constant to itself. A
// constant without the file is a link that 404s at the customer's end, which
// is exactly the class of bug #108 was.
//
// ── This is a shell, and it is an HONEST one ────────────────────────────
//
// get_public_order does not exist yet (Task 3), so there is nothing this can
// truthfully render for a real token, and it says so rather than showing a
// spinner that never resolves or a page of zeroes. That is safe to deploy in
// this state for a reason worth stating: no tokens exist yet either -- they
// are minted in Task 2 -- so there is no link anyone could be holding that
// this would disappoint. Task 6 replaces the body.
//
// NOT bento. Bento tokens are the admin app's; this screen is seen by
// customers, and the storefront's own palette is what it follows (see
// src/app/store/[slug].tsx). The shell below uses neither -- it is plain
// enough not to need a palette, and Task 6 brings the real one in.
export default function PublicOrderRoute() {
  const { token } = useLocalSearchParams<{ token: string }>();

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Order not found</Text>
      <Text style={styles.body}>
        This link may have expired, or it may have been typed incorrectly. Check the message your shop sent you, or
        get in touch with them directly.
      </Text>
      {/* The token is deliberately NOT echoed back. It is a capability: it
          grants whoever holds it a read of someone's order, so it does not
          belong in a screenshot of an error page. */}
      <Text style={styles.hint}>{token ? 'Link not recognised.' : 'No link was provided.'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 10 },
  title: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  body: { fontSize: 14, textAlign: 'center', lineHeight: 20, maxWidth: 420 },
  hint: { fontSize: 12, textAlign: 'center', opacity: 0.6 },
});
