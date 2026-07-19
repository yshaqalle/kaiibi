import { Image } from 'expo-image';
import { useMemo, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

type Product = {
  id: string;
  name: string;
  shop: string;
  price: number;
  category: string;
  image: string;
  color: string;
};

const products: Product[] = [
  { id: '1', name: 'Cedar & Sage Candle', shop: 'North & Pine', price: 24, category: 'Home', color: '#E8DCCB', image: 'https://images.unsplash.com/photo-1603006905003-be475563bc59?auto=format&fit=crop&w=600&q=80' },
  { id: '2', name: 'The Weekend Tote', shop: 'Marlow Goods', price: 68, category: 'Accessories', color: '#D6D6C9', image: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80' },
  { id: '3', name: 'Ripple Glass Set', shop: 'Atelier No. 8', price: 32, category: 'Home', color: '#D6E4E3', image: 'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=600&q=80' },
  { id: '4', name: 'Everyday Crew', shop: 'Studio Twenty', price: 42, category: 'Apparel', color: '#E6D3CC', image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=600&q=80' },
];

const categories = ['All', 'Home', 'Accessories', 'Apparel'];
const spotlights = [
  { title: 'Made for slow mornings', detail: 'Home goods from local makers', image: 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=900&q=80', category: 'Home' },
  { title: 'Carry it everywhere', detail: 'Bags, jewelry & everyday essentials', image: 'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=900&q=80', category: 'Accessories' },
  { title: 'Fresh from the studio', detail: 'Independent labels to know', image: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=900&q=80', category: 'Apparel' },
];

export default function DiscoverScreen() {
  const { width } = useWindowDimensions();
  const isDesktop = width >= 740;
  const columns = width >= 1080 ? 4 : isDesktop ? 3 : 2;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [cart, setCart] = useState<string[]>([]);
  const [selectedShop, setSelectedShop] = useState<string | null>(null);

  const visibleProducts = useMemo(() => products.filter((product) => {
    const matchesQuery = `${product.name} ${product.shop}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (category === 'All' || product.category === category) && (!selectedShop || product.shop === selectedShop);
  }), [category, query, selectedShop]);

  const addToCart = (id: string) => setCart((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, isDesktop && styles.contentDesktop]}>
        <View style={styles.topline}>
          <Text style={styles.brand}>tukaanka</Text>
          <Pressable style={styles.cartButton} onPress={() => setSelectedShop(null)}>
            <Text style={styles.cartLabel}>Bag</Text><Text style={styles.cartCount}>{cart.length}</Text>
          </Pressable>
        </View>

        <View style={[styles.hero, isDesktop && styles.heroDesktop]}>
          <View style={styles.heroCopy}>
            <Text style={styles.eyebrow}>SHOP SMALL. FIND MORE.</Text>
            <Text style={[styles.title, isDesktop && styles.titleDesktop]}>Good things,{"\n"}close to home.</Text>
            <Text style={styles.subtitle}>A marketplace for independent shops and the people who love them.</Text>
          </View>
          {isDesktop && <View style={styles.heroStamp}><Text style={styles.stampBig}>100%</Text><Text style={styles.stampSmall}>independent{`\n`}shops</Text></View>}
        </View>

        <View style={styles.searchBox}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput value={query} onChangeText={setQuery} placeholder="Search products and shops" placeholderTextColor="#8D8C87" style={styles.searchInput} />
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow}>
          {categories.map((item) => <Pressable key={item} onPress={() => { setCategory(item); setSelectedShop(null); }} style={[styles.category, category === item && styles.categoryActive]}><Text style={[styles.categoryText, category === item && styles.categoryTextActive]}>{item}</Text></Pressable>)}
        </ScrollView>

        {!selectedShop && <View style={styles.spotlightBlock}>
          <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>Shop the neighborhood</Text><Text style={styles.productCount}>Made nearby</Text></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.spotlightRow}>
            {spotlights.map((spotlight) => <Pressable key={spotlight.title} onPress={() => setCategory(spotlight.category)} style={styles.spotlightCard}>
              <Image source={{ uri: spotlight.image }} contentFit="cover" style={styles.spotlightImage} />
              <View style={styles.spotlightShade} />
              <View style={styles.spotlightCopy}><Text style={styles.spotlightTitle}>{spotlight.title}</Text><Text style={styles.spotlightDetail}>{spotlight.detail}</Text><Text style={styles.spotlightLink}>Shop now  →</Text></View>
            </Pressable>)}
          </ScrollView>
        </View>}

        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>{selectedShop ? selectedShop : 'Just landed'}</Text>
          <Text style={styles.productCount}>{visibleProducts.length} finds</Text>
        </View>

        <View style={styles.grid}>
          {visibleProducts.map((product) => {
            const added = cart.includes(product.id);
            return <View key={product.id} style={[styles.productCard, { width: `${100 / columns}%` }]}>
              <Pressable onPress={() => setSelectedShop(product.shop)} style={[styles.imageWrap, { backgroundColor: product.color }]}>
                <Image source={{ uri: product.image }} contentFit="cover" transition={300} style={styles.image} />
                <View style={styles.shopPill}><Text style={styles.shopPillText}>{product.shop}</Text></View>
              </Pressable>
              <View style={styles.productInfo}>
                <Text numberOfLines={1} style={styles.productName}>{product.name}</Text>
                <View style={styles.productFooter}><Text style={styles.price}>${product.price}</Text><Pressable onPress={() => addToCart(product.id)} style={[styles.addButton, added && styles.addedButton]}><Text style={styles.addText}>{added ? '✓' : '+'}</Text></Pressable></View>
              </View>
            </View>;
          })}
        </View>

        {selectedShop && <Pressable onPress={() => setSelectedShop(null)} style={styles.clearShop}><Text style={styles.clearShopText}>← View all shops</Text></Pressable>}
        <View style={styles.shopCallout}><Text style={styles.calloutLabel}>ARE YOU A SHOP OWNER?</Text><Text style={styles.calloutTitle}>Your shop belongs here.</Text><Text style={styles.calloutText}>Build your catalog, track what is selling, and meet new customers.</Text><Text style={styles.calloutLink}>Open My Store  →</Text></View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FAF9F5' }, content: { paddingHorizontal: 20, paddingBottom: 42 }, contentDesktop: { width: '100%', maxWidth: 1160, alignSelf: 'center', paddingHorizontal: 38 }, topline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }, brand: { fontSize: 26, fontWeight: '800', letterSpacing: -1.5, color: '#17261F' }, cartButton: { minWidth: 48, height: 38, borderRadius: 19, backgroundColor: '#E8ECE3', alignItems: 'center', justifyContent: 'center', position: 'relative', paddingHorizontal: 12 }, cartLabel: { fontSize: 12, fontWeight: '800', color: '#17261F' }, cartCount: { position: 'absolute', top: -3, right: -1, backgroundColor: '#E45B37', color: '#fff', borderRadius: 9, minWidth: 18, textAlign: 'center', overflow: 'hidden', fontSize: 11, fontWeight: '800', paddingVertical: 2 }, hero: { marginTop: 34 }, heroDesktop: { backgroundColor: '#E5EFE3', borderRadius: 24, paddingHorizontal: 42, paddingVertical: 38, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, heroCopy: {}, eyebrow: { fontSize: 10, letterSpacing: 1.6, fontWeight: '800', color: '#E45B37' }, title: { marginTop: 8, fontSize: 39, lineHeight: 42, letterSpacing: -2, fontWeight: '800', color: '#17261F' }, titleDesktop: { fontSize: 52, lineHeight: 55, letterSpacing: -2.8 }, subtitle: { marginTop: 13, color: '#5B625E', fontSize: 15, lineHeight: 22, maxWidth: 310 }, heroStamp: { width: 150, height: 150, borderRadius: 75, backgroundColor: '#E45B37', alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-9deg' }] }, stampBig: { color: '#fff', fontSize: 29, fontWeight: '800', letterSpacing: -1 }, stampSmall: { color: '#fff', fontSize: 13, lineHeight: 16, textAlign: 'center', marginTop: 2 }, searchBox: { height: 52, backgroundColor: '#FFFFFF', borderRadius: 14, marginTop: 27, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, borderWidth: 1, borderColor: '#EEEDE8' }, searchIcon: { fontSize: 26, color: '#17261F', marginRight: 8, marginTop: -4 }, searchInput: { flex: 1, fontSize: 15, color: '#17261F' }, categoryRow: { gap: 8, paddingVertical: 20 }, category: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 20, backgroundColor: '#EEEDE8' }, categoryActive: { backgroundColor: '#17261F' }, categoryText: { color: '#626760', fontWeight: '700', fontSize: 13 }, categoryTextActive: { color: '#FFFFFF' }, spotlightBlock: { marginBottom: 29 }, spotlightRow: { gap: 12, paddingRight: 20 }, spotlightCard: { width: 270, height: 196, borderRadius: 16, overflow: 'hidden', backgroundColor: '#DDE7D9' }, spotlightImage: { position: 'absolute', width: '100%', height: '100%' }, spotlightShade: { position: 'absolute', inset: 0, backgroundColor: 'rgba(10,29,20,.35)' }, spotlightCopy: { padding: 17, justifyContent: 'flex-end', flex: 1 }, spotlightTitle: { color: '#FFFFFF', fontSize: 22, letterSpacing: -.7, lineHeight: 24, fontWeight: '800', maxWidth: 190 }, spotlightDetail: { color: '#F2F5EF', fontSize: 12, marginTop: 5, maxWidth: 190 }, spotlightLink: { color: '#FFFFFF', fontSize: 12, fontWeight: '800', marginTop: 14 }, sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }, sectionTitle: { fontSize: 22, letterSpacing: -0.7, fontWeight: '800', color: '#17261F' }, productCount: { color: '#7A7F78', fontSize: 12 }, grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 }, productCard: { paddingHorizontal: 6, marginBottom: 22 }, imageWrap: { aspectRatio: .83, borderRadius: 15, overflow: 'hidden', position: 'relative' }, image: { width: '100%', height: '100%' }, shopPill: { position: 'absolute', left: 9, bottom: 9, backgroundColor: 'rgba(255,255,255,.92)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5 }, shopPillText: { fontSize: 10, fontWeight: '800', color: '#17261F' }, productInfo: { paddingTop: 9 }, productName: { fontSize: 14, fontWeight: '700', color: '#26342D' }, productFooter: { marginTop: 5, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, price: { fontSize: 13, fontWeight: '700', color: '#697069' }, addButton: { width: 27, height: 27, borderRadius: 14, backgroundColor: '#E8ECE3', alignItems: 'center', justifyContent: 'center' }, addedButton: { backgroundColor: '#E45B37' }, addText: { fontSize: 18, lineHeight: 20, color: '#17261F', fontWeight: '600' }, clearShop: { alignSelf: 'center', marginBottom: 25 }, clearShopText: { color: '#E45B37', fontWeight: '800' }, shopCallout: { backgroundColor: '#DCE9DB', borderRadius: 19, padding: 23, marginTop: 8 }, calloutLabel: { fontSize: 10, letterSpacing: 1.2, fontWeight: '800', color: '#47705C' }, calloutTitle: { marginTop: 7, fontSize: 25, letterSpacing: -1, fontWeight: '800', color: '#17261F' }, calloutText: { marginTop: 8, fontSize: 14, lineHeight: 20, color: '#4D6355', maxWidth: 280 }, calloutLink: { marginTop: 18, fontWeight: '800', color: '#17261F', fontSize: 14 },
});
