import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatCents } from '@/lib/currency';
import type { Product } from '@/types/models';

export function ProductTile({ product, onPress }: { product: Product; onPress?: () => void }) {
  const lowStock = product.stock <= (product.reorderLevel ?? 5);
  return (
    <Pressable onPress={onPress} style={styles.row}>
      {product.imageUrl ? (
        <Image source={{ uri: product.imageUrl }} contentFit="cover" style={styles.image} />
      ) : (
        <View style={styles.thumb}><Text style={styles.thumbText}>{product.name.charAt(0)}</Text></View>
      )}
      <View style={styles.info}>
        <Text style={styles.name}>{product.name}</Text>
        <Text numberOfLines={1} style={styles.meta}>
          {product.category || 'Uncategorized'}
          {product.shelfNumber ? ` · Shelf ${product.shelfNumber}` : ''}
        </Text>
        <Text style={styles.price}>{formatCents(product.priceCents)}</Text>
      </View>
      <View style={styles.stockInfo}>
        <Text style={[styles.stockStatus, lowStock && styles.lowStock]}>{lowStock ? 'Low stock' : 'In stock'}</Text>
        <Text style={styles.stockCount}>{product.stock} units</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 76, flexDirection: 'row', alignItems: 'center', padding: 11, borderBottomWidth: 1, borderBottomColor: '#F0EFEB' },
  thumb: { width: 47, height: 53, borderRadius: 10, backgroundColor: '#E8DCCB', alignItems: 'center', justifyContent: 'center' },
  image: { width: 47, height: 53, borderRadius: 10, backgroundColor: '#E8DCCB' },
  thumbText: { fontFamily: 'serif', fontSize: 24, color: '#6B5B48' },
  info: { flex: 1, marginLeft: 11 },
  name: { color: '#26342D', fontSize: 13, fontWeight: '700' },
  meta: { color: '#8A908A', fontSize: 10, marginTop: 3 },
  price: { color: '#7B837C', fontSize: 12, marginTop: 3 },
  stockInfo: { alignItems: 'flex-end' },
  stockStatus: { color: '#438254', fontSize: 10, fontWeight: '800' },
  lowStock: { color: '#D27631' },
  stockCount: { color: '#7B837C', fontSize: 11, marginTop: 4 },
});
