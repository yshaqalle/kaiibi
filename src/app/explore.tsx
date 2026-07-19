import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

type InventoryItem = { id: number; name: string; price: string; stock: number; status: 'In stock' | 'Low stock'; description?: string; category?: string; tags?: string[]; image?: string };

const categories = ['Home', 'Accessories', 'Apparel', 'Food & drink', 'Wellness'];
const initialItems: InventoryItem[] = [
  { id: 1, name: 'Cedar & Sage Candle', price: '$24.00', stock: 18, status: 'In stock', category: 'Home', tags: ['candle', 'hand-poured'] },
  { id: 2, name: 'Woven Market Basket', price: '$38.00', stock: 4, status: 'Low stock', category: 'Home', tags: ['woven', 'storage'] },
  { id: 3, name: 'Stoneware Mug', price: '$28.00', stock: 12, status: 'In stock', category: 'Home', tags: ['ceramic', 'kitchen'] },
];

export default function StoreScreen() {
  const [items, setItems] = useState(initialItems);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [category, setCategory] = useState(categories[0]);
  const [tags, setTags] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const totalStock = items.reduce((sum, item) => sum + item.stock, 0);

  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    if (!result.canceled) setImageUri(result.assets[0].uri);
  };

  const addItem = () => {
    if (!name.trim() || !price.trim()) return;
    const quantity = Number(stock) || 0;
    setItems((current) => [{
      id: Date.now(), name: name.trim(), description: description.trim(), category,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), image: imageUri ?? undefined,
      price: price.startsWith('$') ? price : `$${price}`, stock: quantity, status: quantity < 6 ? 'Low stock' : 'In stock',
    }, ...current]);
    setName(''); setDescription(''); setPrice(''); setStock(''); setCategory(categories[0]); setTags(''); setImageUri(null); setAdding(false);
  };

  return <SafeAreaView style={styles.safeArea}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <View style={styles.header}><View><Text style={styles.kicker}>YOUR SHOP</Text><Text style={styles.title}>North & Pine</Text></View><View style={styles.avatar}><Text style={styles.avatarText}>NP</Text></View></View>
    <View style={styles.storeStatus}><View style={styles.statusDot} /><Text style={styles.statusText}>Your storefront is live</Text><Text style={styles.statusArrow}>›</Text></View>
    <Text style={styles.overview}>Today’s overview</Text>
    <View style={styles.metricRow}><Metric value="$486" label="Sales today" tone="#E6D8C0" /><Metric value="7" label="Orders" tone="#D8E6D7" /><Metric value={String(totalStock)} label="Items in stock" tone="#E2E5EE" /></View>
    <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>Products</Text><Text style={styles.sectionSub}>{items.length} active listings</Text></View><Pressable onPress={() => setAdding((value) => !value)} style={styles.addProduct}><Text style={styles.addProductText}>{adding ? 'Close' : '+ Add product'}</Text></Pressable></View>
    {adding && <View style={styles.form}>
      <Text style={styles.formTitle}>New product</Text>
      <Text style={styles.fieldLabel}>PHOTO</Text>
      <Pressable onPress={pickImage} style={styles.photoPicker}>{imageUri ? <Image source={{ uri: imageUri }} contentFit="cover" style={styles.photoPreview} /> : <><Text style={styles.photoIcon}>＋</Text><Text style={styles.photoTitle}>Add a product photo</Text><Text style={styles.photoHint}>Choose from your device</Text></>}</Pressable>
      <TextInput value={name} onChangeText={setName} placeholder="Product name *" placeholderTextColor="#89928B" style={styles.input}/>
      <TextInput value={description} onChangeText={setDescription} placeholder="Description — materials, size, story…" placeholderTextColor="#89928B" style={[styles.input, styles.descriptionInput]} multiline textAlignVertical="top"/>
      <View style={styles.formRow}><TextInput value={price} onChangeText={setPrice} placeholder="Price *" placeholderTextColor="#89928B" keyboardType="decimal-pad" style={[styles.input, styles.halfInput]}/><TextInput value={stock} onChangeText={setStock} placeholder="Quantity" placeholderTextColor="#89928B" keyboardType="number-pad" style={[styles.input, styles.halfInput]}/></View>
      <Text style={styles.fieldLabel}>CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryChoices}>{categories.map((item) => <Pressable key={item} onPress={() => setCategory(item)} style={[styles.categoryChoice, category === item && styles.categoryChoiceActive]}><Text style={[styles.categoryChoiceText, category === item && styles.categoryChoiceTextActive]}>{item}</Text></Pressable>)}</ScrollView>
      <TextInput value={tags} onChangeText={setTags} placeholder="Tags — e.g. handmade, gift, summer" placeholderTextColor="#89928B" style={styles.input}/><Text style={styles.tagHelp}>Separate tags with commas so customers can find this product.</Text>
      <Pressable onPress={addItem} style={styles.save}><Text style={styles.saveText}>Save product</Text></Pressable>
    </View>}
    <View style={styles.inventory}>{items.map((item) => <View key={item.id} style={styles.item}>{item.image ? <Image source={{ uri: item.image }} contentFit="cover" style={styles.itemImage} /> : <View style={styles.thumb}><Text style={styles.thumbText}>{item.name.charAt(0)}</Text></View>}<View style={styles.itemInfo}><Text style={styles.itemName}>{item.name}</Text><Text numberOfLines={1} style={styles.itemMeta}>{item.category || 'Uncategorized'}{item.tags?.length ? ` · ${item.tags.join(', ')}` : ''}</Text><Text style={styles.itemPrice}>{item.price}</Text></View><View style={styles.stockInfo}><Text style={[styles.stockStatus, item.status === 'Low stock' && styles.lowStock]}>{item.status}</Text><Text style={styles.stockCount}>{item.stock} units</Text></View></View>)}</View>
    <View style={styles.tip}><Text style={styles.tipSpark}>✦</Text><View><Text style={styles.tipTitle}>A small nudge</Text><Text style={styles.tipText}>Products with 3+ photos get more views.</Text></View></View>
  </ScrollView></SafeAreaView>;
}

function Metric({ value, label, tone }: { value: string; label: string; tone: string }) { return <View style={[styles.metric, { backgroundColor: tone }]}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>; }

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FAF9F5' }, content: { padding: 20, paddingBottom: 42 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }, kicker: { color: '#E45B37', fontWeight: '800', fontSize: 10, letterSpacing: 1.4 }, title: { color: '#17261F', fontSize: 31, letterSpacing: -1.5, fontWeight: '800', marginTop: 4 }, avatar: { width: 43, height: 43, borderRadius: 22, backgroundColor: '#17261F', alignItems: 'center', justifyContent: 'center' }, avatarText: { color: '#fff', fontWeight: '800', fontSize: 12 }, storeStatus: { marginTop: 25, backgroundColor: '#E5EFE3', padding: 13, borderRadius: 12, flexDirection: 'row', alignItems: 'center' }, statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#5A9569', marginRight: 8 }, statusText: { fontSize: 13, color: '#31533A', fontWeight: '700', flex: 1 }, statusArrow: { fontSize: 25, color: '#31533A', lineHeight: 20 }, overview: { fontSize: 18, fontWeight: '800', color: '#17261F', marginTop: 30, marginBottom: 13 }, metricRow: { flexDirection: 'row', gap: 8 }, metric: { flex: 1, minHeight: 103, padding: 13, borderRadius: 14, justifyContent: 'flex-end' }, metricValue: { color: '#17261F', fontSize: 22, letterSpacing: -1, fontWeight: '800' }, metricLabel: { marginTop: 4, color: '#526058', fontSize: 11, lineHeight: 14 }, sectionHeader: { marginTop: 35, marginBottom: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, sectionTitle: { color: '#17261F', fontSize: 22, fontWeight: '800', letterSpacing: -.7 }, sectionSub: { color: '#798078', fontSize: 12, marginTop: 3 }, addProduct: { backgroundColor: '#17261F', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 10 }, addProductText: { color: '#fff', fontWeight: '800', fontSize: 12 }, form: { backgroundColor: '#EEF2EB', borderRadius: 15, padding: 15, marginBottom: 14 }, formTitle: { fontSize: 17, fontWeight: '800', color: '#17261F', marginBottom: 15 }, fieldLabel: { fontSize: 10, letterSpacing: 1, fontWeight: '800', color: '#657269', marginBottom: 7, marginTop: 3 }, photoPicker: { height: 146, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D5DED2', borderStyle: 'dashed', borderRadius: 11, marginBottom: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, photoPreview: { width: '100%', height: '100%' }, photoIcon: { color: '#3F7850', fontSize: 27, lineHeight: 29 }, photoTitle: { color: '#31533A', fontSize: 13, fontWeight: '800', marginTop: 4 }, photoHint: { color: '#78867C', fontSize: 11, marginTop: 2 }, input: { backgroundColor: '#fff', borderRadius: 9, paddingHorizontal: 11, height: 43, color: '#17261F', marginBottom: 8 }, descriptionInput: { height: 78, paddingTop: 11 }, formRow: { flexDirection: 'row', gap: 8 }, halfInput: { flex: 1 }, categoryChoices: { gap: 7, paddingBottom: 12 }, categoryChoice: { backgroundColor: '#FFFFFF', paddingVertical: 8, paddingHorizontal: 11, borderRadius: 16, borderWidth: 1, borderColor: '#D9E0D6' }, categoryChoiceActive: { backgroundColor: '#31533A', borderColor: '#31533A' }, categoryChoiceText: { fontSize: 11, fontWeight: '700', color: '#546158' }, categoryChoiceTextActive: { color: '#FFFFFF' }, tagHelp: { color: '#78867C', fontSize: 11, marginTop: -2, marginBottom: 12 }, save: { backgroundColor: '#E45B37', height: 42, borderRadius: 9, justifyContent: 'center', alignItems: 'center' }, saveText: { color: '#fff', fontWeight: '800' }, inventory: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#EFEEE9' }, item: { minHeight: 76, flexDirection: 'row', alignItems: 'center', padding: 11, borderBottomWidth: 1, borderBottomColor: '#F0EFEB' }, thumb: { width: 47, height: 53, borderRadius: 10, backgroundColor: '#E8DCCB', alignItems: 'center', justifyContent: 'center' }, itemImage: { width: 47, height: 53, borderRadius: 10, backgroundColor: '#E8DCCB' }, thumbText: { fontFamily: 'serif', fontSize: 24, color: '#6B5B48' }, itemInfo: { flex: 1, marginLeft: 11 }, itemName: { color: '#26342D', fontSize: 13, fontWeight: '700' }, itemMeta: { color: '#8A908A', fontSize: 10, marginTop: 3 }, itemPrice: { color: '#7B837C', fontSize: 12, marginTop: 3 }, stockInfo: { alignItems: 'flex-end' }, stockStatus: { color: '#438254', fontSize: 10, fontWeight: '800' }, lowStock: { color: '#D27631' }, stockCount: { color: '#7B837C', fontSize: 11, marginTop: 4 }, tip: { flexDirection: 'row', gap: 12, backgroundColor: '#F3E9D8', borderRadius: 15, marginTop: 22, padding: 17, alignItems: 'flex-start' }, tipSpark: { color: '#E45B37', fontSize: 20 }, tipTitle: { color: '#5D4930', fontWeight: '800', fontSize: 14 }, tipText: { color: '#7A6549', fontSize: 12, marginTop: 3 },
});
