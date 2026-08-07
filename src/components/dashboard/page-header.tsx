import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { GlobalSearch } from '@/components/dashboard/global-search';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useShopLogo } from '@/hooks/use-shop-logo';
import type { SearchResult } from '@/lib/search';
import { personInitials, shortPersonName } from '@/lib/user-identity';

const theme = Colors.light;

// The Dashboard's own header band: shop mark, name, and the global search.
//
// Scoped to this screen's content area, NOT the nav shell. The shell already
// owns navigation on every platform -- AdminSidebar on wide web, a top header
// plus bottom tabs below the tablet breakpoint, native tabs on device -- so
// this deliberately carries no hamburger and no nav of its own. Duplicating
// them would give the reader two rows of chrome and two ways to go the same
// places.
//
// The logo and the name come from `useAuth()` rather than being passed in,
// for the same reason AdminSidebar reads them there: they are shop identity,
// and a screen that took them as props could be handed the wrong ones.
export function DashboardPageHeader({ onSelectResult }: { onSelectResult: (result: SearchResult) => void }) {
  const { shop, profile, session, myMembership } = useAuth();
  const { editLogo, uploading, canEditLogo, logoUrl } = useShopLogo();
  const { width } = useWindowDimensions();
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();

  // Whose session this is. Named from the profile first and the membership
  // second: an admin owns the shop rather than belonging to it and so has no
  // shop_members row at all (see use-auth's myMembership note), which is also
  // why 'Owner' is read off the profile role rather than looked for there.
  const email = session?.user?.email ?? null;
  const personName = profile?.fullName ?? myMembership?.fullName ?? null;
  const userName = shortPersonName(personName, email);
  const userInitials = personInitials(personName, email);
  const userRole = profile?.role === 'admin' ? 'Owner' : (myMembership?.roleName ?? null);

  // Below the shell's own reflow point the avatar stands alone. The two lines
  // of text next to it would take about 90px off a search field that is already
  // down to its 180px floor on a phone, and the person reading their own
  // dashboard is the one user who does not need to be told whose it is.
  const showUserText = width >= TABLET_BREAKPOINT;

  return (
    <View style={styles.bar}>
      <View style={styles.brand}>
        <Pressable
          onPress={editLogo}
          disabled={!canEditLogo || uploading}
          // Light behind a real logo, dark only behind the fallback initial.
          // A logo is usually a transparent PNG, and on a near-black circle
          // its dark strokes disappear into the background — which is exactly
          // how this looked before.
          style={[styles.mark, logoUrl ? styles.markWithLogo : styles.markFallback, uploading && styles.markBusy]}
          accessibilityLabel={canEditLogo ? 'Change shop logo' : undefined}
          accessibilityRole={canEditLogo ? 'button' : undefined}
        >
          {logoUrl ? (
            <Image source={{ uri: logoUrl }} style={styles.markImage} contentFit="cover" />
          ) : (
            <Text style={styles.markText}>{initial}</Text>
          )}
        </Pressable>
        <View style={styles.brandText}>
          <Text style={styles.shopName} numberOfLines={1}>
            {shop?.name ?? 'Dashboard'}
          </Text>
          {/* Always 'Dashboard'. This used to read "Tap the logo to change it"
              for anyone who could edit it, which put an instruction in the one
              line that should say where you are. The mark keeps its
              accessibilityLabel below, so the affordance is still announced. */}
          <Text style={styles.shopMeta}>Dashboard</Text>
        </View>
      </View>

      {/* Search and the signed-in person travel together on the right, so the
          band reads shop on one end and reader on the other. They share a
          wrapper rather than being two more children of the bar: `bar` wraps,
          and loose children would let the user chip drop to a line of its own
          while the search field kept the first one. */}
      <View style={styles.session}>
        <GlobalSearch onSelect={onSelectResult} />
        {/* Labelled as a whole: the initials are a picture of a name, not a
            name, and on a phone they are all there is. */}
        <View style={styles.user} accessibilityLabel={userRole ? `${userName}, ${userRole}` : userName}>
          <View style={styles.userAvatar}>
            <Text style={styles.userAvatarText}>{userInitials}</Text>
          </View>
          {showUserText ? (
            <View style={styles.userText}>
              <Text style={styles.userName} numberOfLines={1}>
                {userName}
              </Text>
              {userRole ? (
                <Text style={styles.userRole} numberOfLines={1}>
                  {userRole}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    flexWrap: 'wrap',
    backgroundColor: theme.bentoSurface,
    borderRadius: 22,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 14,
    // Keeps the search panel above the cards below it once it opens.
    zIndex: 30,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 11, flexShrink: 1 },
  // `flex: 1` so the search field inside can still take the slack up to its own
  // 340px cap; `justifyContent: flex-end` so what's left of the slack sits
  // between the brand and this pair rather than inside it.
  session: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 12, flex: 1, minWidth: 200 },
  user: { flexDirection: 'row', alignItems: 'center', gap: 9, flexShrink: 1 },
  // The accent, not `bentoInk`: a second black circle at the other end of the
  // band would read as a second shop mark. Accent wash and accent ink are the
  // system's one non-status colour pair (theme.ts), which is what a person's
  // avatar is -- it says who, not how things are going.
  userAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.bentoAccentWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userAvatarText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoAccentInk, letterSpacing: 0.2 },
  userText: { flexShrink: 1 },
  userName: { fontSize: 13, fontWeight: '700', color: theme.bentoInk, lineHeight: 17 },
  userRole: { fontSize: 11.5, color: theme.bentoMuted, lineHeight: 15 },
  mark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  markWithLogo: { backgroundColor: theme.bentoSoft, borderWidth: 1, borderColor: theme.bentoLine },
  markFallback: { backgroundColor: theme.bentoInk },
  markBusy: { opacity: 0.5 },
  markImage: { width: '100%', height: '100%' },
  markText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },
  brandText: { flexShrink: 1 },
  shopName: { fontSize: 15, fontWeight: '800', color: theme.bentoInk, lineHeight: 19 },
  shopMeta: { fontSize: 12, color: theme.bentoMuted, lineHeight: 15 },
});
