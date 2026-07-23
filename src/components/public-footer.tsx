import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export function PublicFooter() {
  const router = useRouter();
  const year = new Date().getFullYear();

  return (
    <View style={styles.footer}>
      <View style={styles.divider} />
      <View style={styles.row}>
        <Text style={styles.copyright}>© {year} Ka Iibi. All rights reserved.</Text>
        <Pressable onPress={() => router.push('/login')}>
          <Text style={styles.loginLink}>Already have a shop? Log in</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: { marginTop: 40 },
  divider: { height: 1, backgroundColor: '#E4E2DC' },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingVertical: 18 },
  copyright: { color: '#8A9089', fontSize: 12, fontWeight: '600' },
  loginLink: { color: '#17261F', fontSize: 12, fontWeight: '800' },
});
