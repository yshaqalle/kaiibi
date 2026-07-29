import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CustomerForm } from '@/components/customer-form';
import { ScreenHeader } from '@/components/screen-header';
import { StatTile } from '@/components/stat-tile';
import { formatCents } from '@/lib/currency';
import { deleteCustomer, getCustomer, getCustomerStats, updateCustomer } from '@/lib/customers';
import type { Customer } from '@/types/models';

export default function EditCustomerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [stats, setStats] = useState<{ totalSpentCents: number; visitCount: number; lastPurchaseAt: string | null } | null>(null);

  useEffect(() => {
    if (!id) return;
    getCustomer(id).then(setCustomer);
    getCustomerStats(id).then(setStats);
  }, [id]);

  if (!customer) return null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScreenHeader title="Edit customer" />
      {stats && (
        <View style={styles.statsRow}>
          <StatTile value={formatCents(stats.totalSpentCents)} label="Total spent" />
          <StatTile value={String(stats.visitCount)} label="Visits" />
          <StatTile value={stats.lastPurchaseAt ? new Date(stats.lastPurchaseAt).toLocaleDateString() : '—'} label="Last purchase" />
        </View>
      )}
      <CustomerForm
        initial={customer}
        shopId={customer.shopId}
        submitLabel="Save changes"
        onSubmit={async (input) => {
          await updateCustomer(customer.id, input);
          router.back();
        }}
        onDelete={async () => {
          await deleteCustomer(customer.id);
          router.back();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  statsRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 14 },
});
