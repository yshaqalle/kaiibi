import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ProductForm } from '@/components/product-form';
import { ScreenHeader } from '@/components/screen-header';
import { useAuth } from '@/hooks/use-auth';
import { createProduct } from '@/lib/products';

export default function NewProductScreen() {
  const router = useRouter();
  const { shop } = useAuth();

  if (!shop) return null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
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
