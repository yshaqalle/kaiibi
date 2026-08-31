import { StyleSheet, View } from 'react-native';

import { SPACE } from '@/components/storefront/scale';

// The first second of every visit.
//
// This page arrives as a forwarded WhatsApp link and opens in an in-app
// browser, on a phone, usually on the slowest connection in the whole flow.
// What it used to show for that second was a bare ActivityIndicator centred on
// #ffffff -- a spinner on a white screen, which says nothing about whose page
// is loading or what shape it will be.
//
// WHAT THIS CAN AND CANNOT DO. It cannot be in the shop's colours: theme and
// palette arrive WITH the fetch this is waiting on, so at paint time nobody
// knows them yet. Colouring it properly means shipping theme and palette ahead
// of the payload, which is a question about what the server sends first and is
// not solved here.
//
// So it earns its place on LAYOUT STABILITY instead, which is worth having on
// its own: the placeholders occupy the same nav-plus-grid shape the real page
// resolves into, so content lands where the eye is already looking rather than
// the whole page jumping when data arrives.
//
// Neutral greys, not a palette import, and that is deliberate rather than
// lazy -- see above. They are the only colour literals in the storefront that
// are not palette-derived, for the one reason that no palette exists yet.
const BONE = '#eeeef1';

export function StorefrontSkeleton() {
  return (
    <View style={styles.page} testID="storefront-skeleton">
      <View style={styles.nav}>
        <View style={styles.nameBlock}>
          <View style={[styles.bone, styles.name]} />
          <View style={[styles.bone, styles.city]} />
        </View>
        <View style={[styles.bone, styles.pill]} />
      </View>

      {/* Four cells, two columns -- the phone case, which is nearly all of
          this traffic. gridColumnsForWidth widens the real grid on a tablet
          or laptop; matching that here would mean measuring the window to
          decide the shape of something on screen for under a second. */}
      <View style={styles.grid}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.cell}>
            <View style={[styles.bone, styles.image]} />
            <View style={[styles.bone, styles.line]} />
            <View style={[styles.bone, styles.lineShort]} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#ffffff' },
  bone: { backgroundColor: BONE, borderRadius: 6 },
  nav: { flexDirection: 'row', alignItems: 'center', padding: SPACE.page, gap: SPACE.gap },
  nameBlock: { flex: 1, gap: 7 },
  name: { height: 17, width: 150 },
  city: { height: 10, width: 74 },
  pill: { height: 30, width: 74, borderRadius: 999, marginLeft: 'auto' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: SPACE.page, gap: SPACE.gap },
  // 48% rather than a computed half: two per row with the gap between them,
  // without this needing to know the window width.
  cell: { width: '48%', gap: 8 },
  image: { width: '100%', aspectRatio: 1, borderRadius: 14 },
  line: { height: 11, width: '85%' },
  lineShort: { height: 11, width: '45%' },
});
