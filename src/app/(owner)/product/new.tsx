import { useRouter } from 'expo-router';
import { SafeAreaView, StyleSheet } from 'react-native';

import { ProductForm } from '@/components/product-form';
import { ScreenHeader } from '@/components/screen-header';
import { useAuth } from '@/hooks/use-auth';
import { createProduct } from '@/lib/products';

export default function NewProductScreen() {
  const router = useRouter();
  const { shop } = useAuth();

  if (!shop) return null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScreenHeader title="Add product" />
      <ProductForm
        shopId={shop.id}
        submitLabel="Save product"
        onSubmit={async (input) => {
          await createProduct(shop.id, input);
          router.back();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safeArea: { flex: 1, backgroundColor: '#FFFFFF' } });
