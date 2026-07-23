import { useRouter } from 'expo-router';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { PosPreviewMock } from '@/components/pos-preview-mock';
import { PublicFooter } from '@/components/public-footer';
import { Fonts } from '@/constants/theme';

const features = [
  { icon: '⚡', title: 'Fast checkout', text: 'Ring up a sale in seconds and accept Cash, ZAAD, e-Dahab, or another wallet.' },
  { icon: '▦', title: 'Live inventory', text: 'Stock updates the moment you sell. Get low-stock and expiry alerts before you run out.' },
  { icon: '📈', title: 'Know your numbers', text: "See today's revenue, top sellers, and orders at a glance — no spreadsheet needed." },
  { icon: '✎', title: 'Built for real retail', text: 'SKU, barcode, brand, batch, and expiry tracking, right down to skincare and beauty stock.' },
];

export default function DiscoverScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isDesktop = width >= 900;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, isDesktop && styles.contentDesktop]}>
        <View style={styles.topline}>
          <Text style={styles.brand}>Ka Iibi</Text>
          <Pressable style={styles.loginButton} onPress={() => router.push('/login')}>
            <Text style={styles.loginLabel}>Log in</Text>
          </Pressable>
        </View>

        <View style={[styles.hero, isDesktop && styles.heroDesktop]}>
          <View style={[styles.heroCopy, isDesktop && styles.heroCopyDesktop]}>
            <Text style={styles.eyebrow}>SIMPLE POS & INVENTORY FOR ANY SHOP</Text>
            <Text style={[styles.title, isDesktop && styles.titleDesktop]}>Sell fast.{'\n'}Stock smart.</Text>
            <Text style={styles.subtitle}>Ka Iibi is a simple, easy-to-use point-of-sale and inventory system for shop owners anywhere — ring up sales in seconds, track every unit, and see what's selling today.</Text>
            <View style={styles.ctaRow}>
              <Pressable style={styles.primaryButton} onPress={() => router.push('/signup')}>
                <Text style={styles.primaryButtonText}>Create your shop — it's free</Text>
              </Pressable>
              <Pressable onPress={() => router.push('/about')}>
                <Text style={styles.secondaryLink}>See how it works →</Text>
              </Pressable>
            </View>
            <Text style={styles.trustLine}>No monthly fees · Works on phone or browser · Cash, ZAAD & e-Dahab ready</Text>
            <View style={styles.roadmapBadge}>
              <Text style={styles.roadmapBadgeIcon}>🛍️</Text>
              <Text style={styles.roadmapBadgeText}>Coming soon: an online marketplace to sell beyond your counter — new e-commerce opportunities for your shop.</Text>
            </View>
          </View>
          <View style={[styles.heroVisual, isDesktop && styles.heroVisualDesktop]}>
            <PosPreviewMock />
          </View>
        </View>

        <View style={styles.sectionHeading}>
          <Text style={styles.sectionLabel}>WHY SHOP OWNERS USE KA IIBI</Text>
          <Text style={styles.sectionTitle}>Everything your till and stockroom need.</Text>
        </View>

        <View style={[styles.featureGrid, isDesktop && styles.featureGridDesktop]}>
          {features.map((feature) => (
            <View key={feature.title} style={[styles.featureCard, isDesktop && styles.featureCardDesktop]}>
              <Text style={styles.featureIcon}>{feature.icon}</Text>
              <Text style={styles.featureTitle}>{feature.title}</Text>
              <Text style={styles.featureText}>{feature.text}</Text>
            </View>
          ))}
        </View>

        <View style={styles.shopCallout}>
          <Text style={styles.calloutLabel}>GET STARTED</Text>
          <Text style={styles.calloutTitle}>Your shop, organized in minutes.</Text>
          <Text style={styles.calloutText}>Create your shop, add your first products, and start selling — all from your phone or browser.</Text>
          <Pressable onPress={() => router.push('/signup')} accessibilityRole="link">
            <Text style={styles.calloutLink}>Create a shop account  →</Text>
          </Pressable>
        </View>

        <PublicFooter />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FAF9F5' },
  content: { paddingHorizontal: 20, paddingBottom: 48 },
  contentDesktop: { width: '100%', maxWidth: 1160, alignSelf: 'center', paddingHorizontal: 38 },
  topline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
  brand: { fontFamily: Fonts.serif, fontSize: 26, fontWeight: '800', letterSpacing: -1, color: '#17261F' },
  loginButton: { height: 38, borderRadius: 19, backgroundColor: '#EEEDE8', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  loginLabel: { fontSize: 12, fontWeight: '800', color: '#17261F' },

  hero: { marginTop: 30 },
  heroDesktop: { flexDirection: 'row', alignItems: 'center', gap: 48, marginTop: 46 },
  heroCopy: {},
  heroCopyDesktop: { flex: 1, maxWidth: 520 },
  eyebrow: { fontSize: 10, letterSpacing: 1.6, fontWeight: '800', color: '#E45B37' },
  title: { fontFamily: Fonts.serif, marginTop: 10, fontSize: 40, lineHeight: 44, letterSpacing: -1, fontWeight: '700', color: '#17261F' },
  titleDesktop: { fontSize: 54, lineHeight: 58 },
  subtitle: { marginTop: 14, color: '#5B625E', fontSize: 15, lineHeight: 22, maxWidth: 440 },
  ctaRow: { marginTop: 22, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 18 },
  primaryButton: { height: 48, borderRadius: 24, backgroundColor: '#17261F', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  secondaryLink: { color: '#17261F', fontSize: 14, fontWeight: '800', textDecorationLine: 'underline' },
  trustLine: { marginTop: 16, color: '#8A9089', fontSize: 12, fontWeight: '600' },
  roadmapBadge: { marginTop: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 9, backgroundColor: '#FBEADD', borderRadius: 13, padding: 13, maxWidth: 440 },
  roadmapBadgeIcon: { fontSize: 16, marginTop: 1 },
  roadmapBadgeText: { flex: 1, color: '#8A5A2E', fontSize: 12, lineHeight: 17, fontWeight: '700' },

  heroVisual: { marginTop: 28, alignItems: 'center' },
  heroVisualDesktop: { flex: 1, marginTop: 0 },

  sectionHeading: { marginTop: 46, marginBottom: 18 },
  sectionLabel: { fontSize: 10, letterSpacing: 1.2, fontWeight: '800', color: '#E45B37' },
  sectionTitle: { marginTop: 8, fontSize: 24, letterSpacing: -0.8, fontWeight: '800', color: '#17261F', maxWidth: 480 },

  featureGrid: { gap: 12 },
  featureGridDesktop: { flexDirection: 'row', flexWrap: 'wrap' },
  featureCard: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EFEEE9', borderRadius: 16, padding: 18 },
  featureCardDesktop: { width: '48.5%' },
  featureIcon: { fontSize: 22 },
  featureTitle: { marginTop: 10, fontSize: 16, fontWeight: '800', color: '#17261F' },
  featureText: { marginTop: 6, fontSize: 13, lineHeight: 19, color: '#667069' },

  shopCallout: { backgroundColor: '#DCE9DB', borderRadius: 19, padding: 23, marginTop: 40 },
  calloutLabel: { fontSize: 10, letterSpacing: 1.2, fontWeight: '800', color: '#47705C' },
  calloutTitle: { marginTop: 7, fontSize: 25, letterSpacing: -1, fontWeight: '800', color: '#17261F' },
  calloutText: { marginTop: 8, fontSize: 14, lineHeight: 20, color: '#4D6355', maxWidth: 280 },
  calloutLink: { marginTop: 18, fontWeight: '800', color: '#17261F', fontSize: 14 },
});
