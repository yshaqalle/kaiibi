import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ProductForm } from '@/components/product-form';
import { ScreenHeader } from '@/components/screen-header';
import { confirmDestructive } from '@/lib/confirm';
import { deleteProduct, getProduct, updateProduct } from '@/lib/products';
import type { Product } from '@/types/models';

export default function EditProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [product, setProduct] = useState<Product | null>(null);

  useEffect(() => { if (id) getProduct(id).then(setProduct); }, [id]);

  if (!product) return null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
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
        onPress={() =>
          confirmDestructive('Delete product?', 'This removes it from inventory. Past sales are not affected.', 'Delete product', async () => {
            await deleteProduct(product.id);
            router.back();
          })
        }
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
