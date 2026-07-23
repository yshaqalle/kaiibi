import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PublicFooter } from '@/components/public-footer';

export default function AboutScreen() {
  return <SafeAreaView style={styles.safeArea}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <View style={styles.hero}>
      <Text style={styles.eyebrow}>KA IIBI · HARGEISA, SOMALILAND</Text>
      <Text style={styles.title}>A simpler way for local shops and local customers to meet.</Text>
      <Text style={styles.intro}>Ka Iibi starts with two people: the shop owner building a business, and the customer looking for something nearby.</Text>
    </View>

    <Text style={styles.sectionLabel}>WHO KA IIBI IS FOR</Text>
    <View style={styles.userCards}>
      <View style={[styles.userCard, styles.ownerCard]}><Text style={styles.cardIcon}>▦</Text><Text style={styles.cardTitle}>Store owners</Text><Text style={styles.cardText}>Create a digital shelf for your Hargeisa shop, keep stock organized, and help new customers discover what you sell.</Text><Text style={styles.cardNeed}>You need: a simple catalog, clear inventory, and more reach.</Text></View>
      <View style={[styles.userCard, styles.customerCard]}><Text style={styles.cardIcon}>⌕</Text><Text style={styles.cardTitle}>Customers</Text><Text style={styles.cardText}>Browse familiar local shops, search for useful products, and find the right item before making a purchase.</Text><Text style={styles.cardNeed}>You need: trusted shops, useful details, and an easy way to browse.</Text></View>
    </View>

    <View style={styles.divider} />
    <Text style={styles.sectionLabel}>FOR STORE OWNERS</Text><Text style={styles.sectionTitle}>Set up your shop in four simple steps.</Text>
    <View style={styles.steps}>
      <Step number="01" title="Create your shop" text="Add your shop name, location in Hargeisa, contact details, and a short introduction so customers know who you are." />
      <Step number="02" title="Add your first products" text="For every item, upload a photo, name it, set a price, choose a category, and write a useful description." />
      <Step number="03" title="Organize your inventory" text="Set the quantity you have available and add tags such as handmade, groceries, or home. Update stock as items sell." />
      <Step number="04" title="Keep your storefront current" text="Review low-stock items, add new arrivals, and make sure product photos and prices stay accurate." />
    </View>

    <View style={styles.divider} />
    <Text style={styles.sectionLabel}>FOR CUSTOMERS</Text><Text style={styles.sectionTitle}>Find what you need, close to home.</Text>
    <View style={styles.customerSteps}><Text style={styles.customerStep}>1. Search or browse products and local shops.</Text><Text style={styles.customerStep}>2. Compare prices, product details, and available stock.</Text><Text style={styles.customerStep}>3. Choose a shop and purchase with confidence.</Text></View>
    <View style={styles.mission}><Text style={styles.missionLabel}>THE MVP</Text><Text style={styles.missionTitle}>Built for Hargeisa’s local commerce.</Text><Text style={styles.missionText}>We are beginning with a focused marketplace that makes inventory and discovery easier for the businesses and people already shaping the city.</Text></View>

    <PublicFooter />
  </ScrollView></SafeAreaView>;
}

function Step({ number, title, text }: { number: string; title: string; text: string }) { return <View style={styles.step}><Text style={styles.stepNumber}>{number}</Text><View style={styles.stepCopy}><Text style={styles.stepTitle}>{title}</Text><Text style={styles.stepText}>{text}</Text></View></View>; }

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FAF9F5' }, content: { width: '100%', maxWidth: 900, alignSelf: 'center', paddingHorizontal: 20, paddingVertical: 30, paddingBottom: 60 }, hero: { backgroundColor: '#E2EEE0', borderRadius: 22, padding: 28 }, eyebrow: { color: '#47705C', letterSpacing: 1.2, fontSize: 10, fontWeight: '800' }, title: { color: '#17261F', fontSize: 35, lineHeight: 39, letterSpacing: -1.8, fontWeight: '800', marginTop: 10, maxWidth: 620 }, intro: { color: '#4B6253', fontSize: 15, lineHeight: 22, marginTop: 15, maxWidth: 570 }, sectionLabel: { color: '#E45B37', letterSpacing: 1.25, fontSize: 10, fontWeight: '800', marginTop: 34, marginBottom: 8 }, userCards: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, userCard: { flexGrow: 1, flexBasis: 280, minHeight: 222, borderRadius: 17, padding: 20 }, ownerCard: { backgroundColor: '#F1E6D6' }, customerCard: { backgroundColor: '#DCE8E8' }, cardIcon: { color: '#17261F', fontSize: 25, fontWeight: '800' }, cardTitle: { color: '#17261F', fontSize: 21, fontWeight: '800', letterSpacing: -.6, marginTop: 10 }, cardText: { color: '#49574F', fontSize: 13, lineHeight: 19, marginTop: 7 }, cardNeed: { color: '#17261F', fontSize: 12, lineHeight: 17, fontWeight: '800', marginTop: 14 }, divider: { height: 1, backgroundColor: '#E4E2DC', marginTop: 34 }, sectionTitle: { color: '#17261F', fontSize: 26, lineHeight: 30, letterSpacing: -1, fontWeight: '800', maxWidth: 520 }, steps: { marginTop: 22, gap: 0 }, step: { flexDirection: 'row', paddingVertical: 17, borderTopWidth: 1, borderTopColor: '#E5E3DD' }, stepNumber: { width: 48, color: '#E45B37', fontSize: 12, letterSpacing: .8, fontWeight: '800', paddingTop: 3 }, stepCopy: { flex: 1 }, stepTitle: { color: '#17261F', fontSize: 17, fontWeight: '800' }, stepText: { color: '#667069', fontSize: 13, lineHeight: 19, marginTop: 5, maxWidth: 560 }, customerSteps: { marginTop: 19, gap: 9 }, customerStep: { color: '#4F5D55', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E9E7E2', padding: 14, borderRadius: 11, fontSize: 14, lineHeight: 20 }, mission: { backgroundColor: '#17261F', borderRadius: 19, padding: 23, marginTop: 35 }, missionLabel: { color: '#B5D8B6', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 }, missionTitle: { color: '#FFFFFF', fontSize: 24, letterSpacing: -.8, fontWeight: '800', marginTop: 8 }, missionText: { color: '#D4E1D2', fontSize: 13, lineHeight: 20, marginTop: 8, maxWidth: 580 },
});
