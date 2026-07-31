import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Public, unauthenticated page (same pattern as marketplace-coming-soon.tsx —
// a standalone top-level route, not nested in (public)/(admin), so it's
// reachable without signing in). Its URL (/privacy/policy) is what's on file
// as the app's Privacy Policy URL in App Store Connect and Google Play's Data
// Safety form, so the path shouldn't change without updating both. Also
// linked in-app from signup.tsx, per App Store guideline 5.1.1(i) (privacy
// policy must be linked both in App Store Connect metadata and in-app).
const CONTACT_EMAIL = 'info@kaiibi.com';
const LAST_UPDATED = 'July 30, 2026';

export default function PrivacyPolicyScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        {router.canGoBack() && (
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backButtonText}>‹ Back</Text>
          </Pressable>
        )}
        <Text style={styles.eyebrow}>KA IIBI</Text>
        <Text style={styles.title}>Privacy Policy</Text>
        <Text style={styles.updated}>Last updated: {LAST_UPDATED}</Text>

        <Text style={styles.paragraph}>
          Ka Iibi (&quot;Ka Iibi&quot;, &quot;we&quot;, &quot;us&quot;) provides a point-of-sale and shop-management app
          used by shop owners and their staff to manage inventory, take sales, and run their
          business. This policy explains what information we collect through the app, how
          it&apos;s used, and who it&apos;s shared with.
        </Text>

        <Section title="Who this policy covers">
          <Text style={styles.paragraph}>
            Ka Iibi is used by two kinds of people. <Text style={styles.bold}>Shop owners and staff</Text> create
            an account to run the app. <Text style={styles.bold}>A shop&apos;s own customers</Text> aren&apos;t
            app users themselves — their contact details are entered into the app by shop staff (e.g. a
            phone number captured at checkout) so the shop can look up a repeat customer. We process that
            customer data on the shop&apos;s behalf and behalf only; the shop, not Ka Iibi, decides what&apos;s
            collected about its customers and is responsible for having the right to store it.
          </Text>
        </Section>

        <Section title="Information we collect">
          <Bullet label="Account information">
            Email address, full name, and phone number when you create an account or are added
            as staff, and the password you set (stored securely by our authentication provider,
            never in plain text).
          </Bullet>
          <Bullet label="Shop data">
            Your shop&apos;s name, category, logo, tax settings, and the roles and permissions you
            configure for staff.
          </Bullet>
          <Bullet label="Product and inventory data">
            Product names, prices, cost, stock levels, suppliers, and any product photos you
            upload.
          </Bullet>
          <Bullet label="Sales and transaction data">
            Items sold, prices, discounts, tax, payment method, and the cashier who rang up the
            sale.
          </Bullet>
          <Bullet label="Customer directory data">
            Name, phone number, email, address, and notes a shop&apos;s staff enter about that shop&apos;s
            own customers.
          </Bullet>
          <Bullet label="Photos and camera">
            With your permission, access to your photo library or camera — used only when you
            choose to attach a photo to a product or your shop&apos;s logo. We don&apos;t access your
            photos for any other purpose.
          </Bullet>
        </Section>

        <Section title="What we don't collect">
          <Text style={styles.paragraph}>
            Ka Iibi does not use third-party advertising or analytics SDKs, does not access your
            contacts or precise location, and does not sell personal information to anyone.
          </Text>
        </Section>

        <Section title="How we use this information">
          <Text style={styles.paragraph}>
            We use the information above to operate the app: to authenticate you, to run the
            inventory, sales, and staff-management features you use, to enforce the permissions
            your shop configures for its staff, and to provide support when you contact us.
          </Text>
        </Section>

        <Section title="How we store and protect it">
          <Text style={styles.paragraph}>
            App data is stored with our cloud infrastructure provider, using access controls
            (row-level security) that scope every shop&apos;s data to that shop&apos;s own account and its
            staff&apos;s configured permissions — one shop can&apos;t see another shop&apos;s data. Data is
            encrypted in transit.
          </Text>
        </Section>

        <Section title="Who we share it with">
          <Text style={styles.paragraph}>
            We don&apos;t sell or rent your information, and we don&apos;t use any advertising or analytics
            SDKs that would share it with a third party. We share it only with the cloud
            infrastructure provider that operates the app on our behalf — for the database,
            authentication, and file storage — which is contractually bound to protect it to the
            same standard set out in this policy, or when required to comply with the law.
          </Text>
        </Section>

        <Section title="Data retention and deletion">
          <Text style={styles.paragraph}>
            We keep your account and shop data for as long as your account is active. You can ask
            us to delete your account and associated data at any time by contacting us below; a
            shop&apos;s staff and customer records are deleted along with the shop&apos;s account.
          </Text>
        </Section>

        <Section title="Children's privacy">
          <Text style={styles.paragraph}>
            Ka Iibi is a business tool and isn&apos;t directed at children. We don&apos;t knowingly collect
            personal information from anyone under 16.
          </Text>
        </Section>

        <Section title="Changes to this policy">
          <Text style={styles.paragraph}>
            If we make material changes to this policy, we&apos;ll update the &quot;Last updated&quot; date
            above. Continued use of the app after a change means you accept the updated policy.
          </Text>
        </Section>

        <Section title="Contact us">
          <Text style={styles.paragraph}>
            Questions about this policy, or a request to access or delete your data? Email us at{' '}
            <Text style={styles.bold}>{CONTACT_EMAIL}</Text>.
          </Text>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Bullet({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Text style={styles.paragraph}>
      <Text style={styles.bold}>{label}. </Text>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', padding: 24, paddingBottom: 60 },
  backButton: { alignSelf: 'flex-start', backgroundColor: '#F2F2F2', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12, marginBottom: 16 },
  backButtonText: { color: '#111111', fontSize: 12, fontWeight: '700' },
  eyebrow: { color: '#999999', letterSpacing: 1.3, fontSize: 10, fontWeight: '800' },
  title: { color: '#111111', fontSize: 28, letterSpacing: -1, fontWeight: '800', marginTop: 6 },
  updated: { color: '#999999', fontSize: 12, fontWeight: '600', marginTop: 6, marginBottom: 20 },
  section: { marginTop: 22 },
  sectionTitle: { color: '#111111', fontSize: 15, fontWeight: '800', marginBottom: 8 },
  paragraph: { color: '#444444', fontSize: 14, lineHeight: 22, marginBottom: 10 },
  bold: { color: '#111111', fontWeight: '700' },
});
