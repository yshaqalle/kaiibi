import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { withModuleWall } from '@/components/module-wall';
import { ProductForm } from '@/components/product-form';
import { ScreenHeader } from '@/components/screen-header';
import { useAuth } from '@/hooks/use-auth';
import { createProduct } from '@/lib/products';

function NewProductScreen() {
  const router = useRouter();
  const { shop } = useAuth();

  if (!shop) return null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScreenHeader title="Add product" />
      <ProductForm
        shopId={shop.id}
        submitLabel="Save product"
        onSubmit={async (input, locationId) => {
          await createProduct(shop.id, input, locationId);
          router.back();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safeArea: { flex: 1, backgroundColor: '#FFFFFF' } });

// Same wall, and it brings a `ScreenHeader` because this screen is pushed over
// the admin shell rather than living inside it -- without one, a walled screen
// would have no Back and no Home. See components/module-wall.tsx.
export default withModuleWall('inventory', NewProductScreen, { title: 'New product' });
