import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import OwnerTabs from '@/components/owner-tabs';
import { useAuth } from '@/hooks/use-auth';

export default function OwnerLayout() {
  const { loading, session, profile } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session || profile?.role !== 'owner') {
    return <Redirect href="/signup" />;
  }

  return <OwnerTabs />;
}
