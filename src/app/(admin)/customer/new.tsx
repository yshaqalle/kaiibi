import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CustomerForm } from '@/components/customer-form';
import { ScreenHeader } from '@/components/screen-header';
import { useAuth } from '@/hooks/use-auth';
import { createCustomer } from '@/lib/customers';

export default function NewCustomerScreen() {
  const router = useRouter();
  const { shop } = useAuth();

  if (!shop) return null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScreenHeader title="Add customer" />
      <CustomerForm
        shopId={shop.id}
        submitLabel="Save customer"
        onSubmit={async (input) => {
          await createCustomer(shop.id, input);
          router.back();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safeArea: { flex: 1, backgroundColor: '#FFFFFF' } });
