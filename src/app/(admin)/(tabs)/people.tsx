import { useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SegmentedControl } from '@/components/segmented-control';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { useAuth } from '@/hooks/use-auth';

type PeopleTab = 'customers' | 'team';

const TEAM_PERMISSIONS = ['staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view'] as const;

export default function PeopleScreen() {
  const { can, canAny } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;
  const canSeeCustomers = can('customers.view');
  const canSeeTeam = canAny([...TEAM_PERMISSIONS]);
  const [tab, setTab] = useState<PeopleTab>(canSeeCustomers ? 'customers' : 'team');

  const options = [
    ...(canSeeCustomers ? [{ key: 'customers' as const, label: 'Customers' }] : []),
    ...(canSeeTeam ? [{ key: 'team' as const, label: 'Team' }] : []),
  ];

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <View style={styles.header}>
        <Text style={styles.title}>People</Text>
        {options.length > 1 && <SegmentedControl options={options} value={tab} onChange={setTab} />}
      </View>
      <View style={styles.body}>
        {tab === 'customers' && canSeeCustomers ? <CustomersTab compact={compact} /> : null}
        {tab === 'team' && canSeeTeam ? <TeamTab compact={compact} /> : null}
      </View>
    </SafeAreaView>
  );
}

// Placeholder bodies -- Task 11 replaces CustomersTab (list+detail, filter
// chips, notes, purchase history) and Task 12 replaces TeamTab (roster
// list+detail, payroll, shifts, access grid, time-off approvals). Kept as
// separate named components here so those tasks swap a function body
// rather than restructuring this shell.
function CustomersTab({ compact }: { compact: boolean }) {
  return <Text style={styles.placeholder}>Customers — coming in Task 11.</Text>;
}
function TeamTab({ compact }: { compact: boolean }) {
  return <Text style={styles.placeholder}>Team — coming in Task 12.</Text>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  header: { paddingHorizontal: 24, paddingTop: 24 },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5, marginBottom: 14 },
  body: { flex: 1, paddingHorizontal: 24, paddingBottom: 24 },
  placeholder: { color: '#999999', fontSize: 13 },
});
