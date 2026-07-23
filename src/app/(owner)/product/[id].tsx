import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text } from 'react-native';

import { ProductForm } from '@/components/product-form';
import { ScreenHeader } from '@/components/screen-header';
import { deleteProduct, getProduct, updateProduct } from '@/lib/products';
import type { Product } from '@/types/models';

export default function EditProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [product, setProduct] = useState<Product | null>(null);

  useEffect(() => { if (id) getProduct(id).then(setProduct); }, [id]);

  if (!product) return null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScreenHeader title="Edit product" />
      <ProductForm
        initial={product}
        shopId={product.shopId}
        submitLabel="Save changes"
        onSubmit={async (input) => {
          await updateProduct(product.id, input);
          router.back();
        }}
      />
      <Pressable
        onPress={async () => { await deleteProduct(product.id); router.back(); }}
        style={styles.deleteButton}>
        <Text style={styles.deleteText}>Delete product</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  deleteButton: { alignItems: 'center', paddingVertical: 16 },
  deleteText: { color: '#C0392B', fontWeight: '800', fontSize: 13 },
});
