# Mobile Login-First Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native (iOS/Android) open directly to login (or straight to the dashboard/marketplace stub if already signed in), with the marketing landing page and "How it works" demoted to link-accessible screens — while web keeps its current landing-first, tab-based homepage untouched.

**Architecture:** Split `src/app/(public)/_layout.tsx` by platform using Expo Router's supported `_layout.web.tsx` / `_layout.tsx` convention (same mechanism already used for `app-tabs.web.tsx`/`app-tabs.tsx`): the web file is an unmodified copy of today's layout; the native file gains an auth/role-aware redirect gate (mirroring the existing pattern in `src/app/(admin)/_layout.tsx`) and makes `login` its initial route. Native's public tab bar (`src/components/app-tabs.tsx`) is converted from `NativeTabs` to a plain `Stack`, so landing/how-it-works/signup become pushed screens with native headers instead of tabs. `login.tsx` gains a black hero band (tagline + links + the new K mark as a watermark) above the existing form.

**Tech Stack:** Expo Router (SDK 57), React Native, `expo-image`, Supabase auth via `src/lib/auth.ts` / `src/hooks/use-auth.tsx`. No new dependencies.

## Global Constraints
- Web behavior and web-rendered files must not change at all — verify by diffing `_layout.web.tsx` against the pre-change `_layout.tsx` (must be byte-identical except the file name) and by running `expo start --web` after every task.
- No new npm dependencies.
- Public/marketing screens (`login.tsx`, `about.tsx`, `signup.tsx`, `(tabs)/index.tsx`) use plain `StyleSheet.create` with the existing hardcoded hex palette (`#111111` black, `#FFFFFF` white, `#F2F2F2` light gray, `#999999`/`#666666` muted text, `#C0392B` error) — do not introduce the `Colors` theme tokens from `src/constants/theme.ts` on these screens; that token set belongs to the admin/dashboard side of the app and uses a different palette.
- This codebase has no component/navigation test setup (`@testing-library/react-native` is not installed; the only existing tests are pure-logic unit tests under `src/lib/__tests__/`). Do not add component tests for this feature — follow the existing convention and verify navigation/UI changes manually (`npx expo start`, check web and a native simulator) plus `npx tsc --noEmit` and `npm run lint` for regressions.
- Every task's automated verification is `npx tsc --noEmit` (must show no new errors) and `npm run lint` (must show no new warnings/errors in touched files).

---

### Task 1: Freeze current behavior for web via `_layout.web.tsx`

**Files:**
- Create: `src/app/(public)/_layout.web.tsx`
- Reference (do not modify yet): `src/app/(public)/_layout.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: web's `(public)` routing is now sourced from `_layout.web.tsx`, completely decoupled from whatever `_layout.tsx` (native) becomes in Task 3. Later tasks may freely rewrite `_layout.tsx` without touching this file.

- [ ] **Step 1: Create `src/app/(public)/_layout.web.tsx` as an exact copy of the current `_layout.tsx`**

```tsx
import { Stack } from 'expo-router';

// `(tabs)` hosts the 3 tab-bar routes (index/about/signup) via AppTabs.
// `login` is not a tab — it's a screen that should push on top of the tab
// bar, the same way it does automatically on native. This Stack is what
// makes that push-over-tabs behavior work on web too: expo-router/ui's
// `Tabs`/`TabSlot` only ever renders routes declared as `<TabTrigger>`, so a
// route outside that set needs a real Stack screen to host it.
//
// Web-only: kept byte-for-byte identical to the pre-2026-07-28 `_layout.tsx`
// so web's landing-first behavior never changes. Native's `_layout.tsx` now
// diverges (login-first, auth-aware redirect) — see that file's comments.
export default function PublicLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="login" options={{ headerShown: true, title: 'Log in', headerBackButtonDisplayMode: 'minimal' }} />
    </Stack>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `_layout.web.tsx`.

Run: `npm run lint`
Expected: no new warnings/errors.

- [ ] **Step 3: Verify web is unaffected**

Run: `npx expo start --web` and open the app in a browser.
Expected: identical to before this change — landing page (`/`) loads by default, tab bar shows Home/How it works/Sign up, "Log in" pushes the login screen with a native-style header. Stop the dev server when done.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(public\)/_layout.web.tsx
git commit -m "Freeze web (public) layout behind _layout.web.tsx before native redesign"
```

---

### Task 2: Add the customer-role placeholder screen

**Files:**
- Create: `src/app/(public)/marketplace-coming-soon.tsx`
- Reference: `src/lib/auth.ts` (for `signOut`)

**Interfaces:**
- Consumes: `signOut(): Promise<void>` from `src/lib/auth.ts:19-22`.
- Produces: route `/marketplace-coming-soon`, used by Task 3's redirect gate as the landing spot for an authenticated `customer`-role session. This is a structural stub only — no real marketplace UI — matching the design spec's explicit scope cut.

- [ ] **Step 1: Create `src/app/(public)/marketplace-coming-soon.tsx`**

```tsx
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { signOut } from '@/lib/auth';

export default function MarketplaceComingSoonScreen() {
  return <SafeAreaView style={styles.safeArea}><View style={styles.content}>
    <Text style={styles.eyebrow}>KA IIBI · MARKETPLACE</Text>
    <Text style={styles.title}>Coming soon.</Text>
    <Text style={styles.text}>The Ka Iibi marketplace for shoppers isn't ready yet — we're building it. Check back soon.</Text>
    <Pressable onPress={() => signOut()} style={styles.logoutButton}>
      <Text style={styles.logoutText}>Log out</Text>
    </Pressable>
  </View></SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { flex: 1, width: '100%', maxWidth: 480, alignSelf: 'center', padding: 22, justifyContent: 'center' },
  eyebrow: { color: '#999999', letterSpacing: 1.3, fontSize: 10, fontWeight: '800' },
  title: { color: '#111111', fontSize: 30, letterSpacing: -1.3, fontWeight: '800', marginTop: 8, marginBottom: 12 },
  text: { color: '#666666', fontSize: 14, lineHeight: 21 },
  logoutButton: { height: 45, borderRadius: 9, borderWidth: 1.5, borderColor: '#111111', alignItems: 'center', justifyContent: 'center', marginTop: 24 },
  logoutText: { color: '#111111', fontSize: 14, fontWeight: '800' },
});
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `marketplace-coming-soon.tsx`.

Run: `npm run lint`
Expected: no new warnings/errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(public\)/marketplace-coming-soon.tsx
git commit -m "Add marketplace-coming-soon placeholder for customer-role sessions"
```

---

### Task 3: Native login-first redirect gate on `(public)/_layout.tsx`

**Files:**
- Modify: `src/app/(public)/_layout.tsx` (full rewrite — native only, since Task 1 moved web's copy to `_layout.web.tsx`)
- Reference: `src/hooks/use-auth.tsx` (`useAuth()` shape: `{ session, profile, shop, loading, refreshShop, setProfile }`), `src/app/(admin)/_layout.tsx` (existing loading/redirect pattern this mirrors)

**Interfaces:**
- Consumes: `useAuth()` from `@/hooks/use-auth` — `loading: boolean`, `session: Session | null`, `profile: Profile | null` where `profile.role: 'admin' | 'customer' | 'staff'` (`src/types/models.ts:5`). Route `/marketplace-coming-soon` (Task 2). Pre-existing routes `/dashboard`, `/login`.
- Produces: native's `(public)` group now redirects authenticated sessions away entirely and shows `login` as the first screen for everyone else. `(tabs)` and `login` remain declared as sibling `Stack.Screen`s so Task 4's changes to `app-tabs.tsx` continue to be reachable at `/`, `/about`, `/signup`.

- [ ] **Step 1: Rewrite `src/app/(public)/_layout.tsx`**

```tsx
import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';

// Native only — web's (public) layout lives in `_layout.web.tsx` and is
// unaffected by anything below. On native, `(public)` is now gated: an
// authenticated admin/staff session skips straight to the dashboard, an
// authenticated customer session goes to the marketplace stub, and
// everyone else lands on `login` (this Stack's initial route) instead of
// the marketing tabs. `(tabs)` (landing/how-it-works/signup) and the new
// `marketplace-coming-soon` screen are still reachable as pushed screens —
// see `app-tabs.tsx` for how native reaches `(tabs)`'s children without a
// tab bar.
export default function PublicLayout() {
  const { loading, session, profile } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (session && (profile?.role === 'admin' || profile?.role === 'staff')) {
    return <Redirect href="/dashboard" />;
  }

  if (session && profile?.role === 'customer') {
    return <Redirect href="/marketplace-coming-soon" />;
  }

  return (
    <Stack initialRouteName="login" screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="marketplace-coming-soon" options={{ headerShown: true, title: '', headerBackButtonDisplayMode: 'minimal' }} />
    </Stack>
  );
}
```

Note: `login` gets no `options` override here (unlike web's `_layout.web.tsx`, which sets `headerShown: true, title: 'Log in'`), so it inherits this Stack's `headerShown: false` default. On native it's the Stack's initial route with nothing to go "back" to, and Task 5's hero band already carries the branding a header would otherwise provide — a header bar here would be redundant chrome. Web still shows a header for `login` because it's always a pushed screen there.

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `(public)/_layout.tsx`. (A pre-existing type error may appear because `login.tsx` doesn't yet accept being an initial/headerless route — that's fine, Task 5 finishes it.)

Run: `npm run lint`
Expected: no new warnings/errors.

- [ ] **Step 3: Verify native redirect behavior manually**

Run: `npx expo start` and open on an iOS or Android simulator.
Expected, before Task 5's login redesign lands: app opens directly to the (currently still old-styled) `login` screen when signed out, with no header bar and no tab bar visible. Sign in with an admin/staff test account and relaunch — expect an immediate jump to `/dashboard`, no login/landing screen shown at all.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(public\)/_layout.tsx
git commit -m "Add native login-first auth gate to (public) layout"
```

---

### Task 4: Convert native public tabs to a plain Stack (no tab bar)

**Files:**
- Modify: `src/components/app-tabs.tsx` (native — full rewrite)
- Reference (do not modify): `src/components/app-tabs.web.tsx`, `src/app/(public)/(tabs)/_layout.tsx` (still just renders `<AppTabs />`, unchanged)

**Interfaces:**
- Consumes: nothing new — still the default export rendered by `src/app/(public)/(tabs)/_layout.tsx:8-9`.
- Produces: on native, `/` (landing), `/about`, `/signup` are now reachable as pushed Stack screens with native headers instead of `NativeTabs` tab-bar items. Web (`app-tabs.web.tsx`) is untouched and keeps its own top-nav `Tabs`/`TabSlot` implementation.

- [ ] **Step 1: Rewrite `src/components/app-tabs.tsx`**

```tsx
import { Stack } from 'expo-router';

// Native only — web's version of this component (`app-tabs.web.tsx`) keeps
// its own top-nav `Tabs`/`TabSlot` implementation, untouched. On native,
// `login` (see `(public)/_layout.tsx`) is the app's home screen; these 3
// screens are no longer parallel tab destinations, just pushed screens
// reached via buttons/links from login or from each other.
export default function AppTabs() {
  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ headerShown: true, title: '' }} />
      <Stack.Screen name="about" options={{ headerShown: true, title: 'How it works' }} />
      <Stack.Screen name="signup" options={{ headerShown: true, title: 'Create your shop' }} />
    </Stack>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `app-tabs.tsx`. (`useColorScheme`/`Colors` imports are gone — confirm no other file imports removed exports from this module; `grep -rn "from '@/components/app-tabs'" src` should show only `(public)/(tabs)/_layout.tsx`.)

Run: `npm run lint`
Expected: no new warnings/errors.

- [ ] **Step 3: Verify native navigation manually**

Run: `npx expo start` and open on an iOS or Android simulator, signed out.
Expected: from the login screen, tapping "See how it works" / whatever link exists pre-Task-5 pushes `/about` with a native header ("How it works", back chevron). From `about`, hardware/gesture back returns to `login`. Repeat for `/signup` ("Create your shop" header) and confirm no tab bar renders anywhere in `(public)`.

- [ ] **Step 4: Commit**

```bash
git add src/components/app-tabs.tsx
git commit -m "Replace native public NativeTabs with a plain pushed Stack"
```

---

### Task 5: Redesign `login.tsx` with the black hero band and K mark

**Files:**
- Modify: `src/app/(public)/login.tsx` (full rewrite)
- Reference: `assets/images/cover.jpeg` (already committed to the repo), `src/constants/theme.ts` (`Fonts.serif`)

**Interfaces:**
- Consumes: `signIn(params: { email: string; password: string }): Promise<AuthResponse['data']>` from `src/lib/auth.ts:13-17` (unchanged call site), `Fonts` from `@/constants/theme`, routes `/about` and `/signup` (both exist; on native they're the Task 4 pushed Stack screens, on web they're the untouched tab routes).
- Produces: no new exports — this is a leaf screen component.

- [ ] **Step 1: Rewrite `src/app/(public)/login.tsx`**

```tsx
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';

import { signIn } from '@/lib/auth';
import { Fonts } from '@/constants/theme';

const kMark = require('@/assets/images/cover.jpeg');

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await signIn({ email: email.trim(), password });
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log in. Check your email and password.');
    } finally {
      setSubmitting(false);
    }
  };

  return <SafeAreaView style={styles.safeArea}><View style={styles.content}>
    <View style={styles.hero}>
      <Image source={kMark} contentFit="contain" style={styles.heroMark} />
      <Text style={styles.heroEyebrow}>SIMPLE POS & INVENTORY</Text>
      <Text style={styles.heroTitle}>Sell fast.{'\n'}Stock smart.</Text>
      <Text style={styles.heroTrust}>No monthly fees · Works on phone or browser</Text>
      <View style={styles.heroLinks}>
        <Pressable onPress={() => router.push('/about')}><Text style={styles.heroLink}>How it works</Text></Pressable>
        <Pressable onPress={() => router.push('/signup')}><Text style={styles.heroLink}>Create a shop</Text></Pressable>
      </View>
    </View>

    <View style={styles.brandRow}>
      <View style={styles.markTile}><Image source={kMark} contentFit="cover" style={styles.markTileImage} /></View>
      <Text style={styles.eyebrow}>WELCOME BACK</Text>
    </View>
    <View style={styles.form}>
      <Text style={styles.fieldLabel}>EMAIL</Text>
      <TextInput value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor="#999999" autoCapitalize="none" keyboardType="email-address" style={styles.input}/>
      <Text style={styles.fieldLabel}>PASSWORD</Text>
      <TextInput value={password} onChangeText={setPassword} placeholder="Your password" placeholderTextColor="#999999" secureTextEntry style={styles.input}/>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={submit} style={[styles.submit, submitting && styles.submitDisabled]} disabled={submitting}><Text style={styles.submitText}>{submitting ? 'Logging in…' : 'Log in'}</Text></Pressable>
    </View>
  </View></SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { flex: 1, width: '100%', maxWidth: 480, alignSelf: 'center', padding: 22, justifyContent: 'center' },
  hero: { position: 'relative', overflow: 'hidden', backgroundColor: '#111111', borderRadius: 19, padding: 20, marginBottom: 22 },
  heroMark: { position: 'absolute', top: -30, right: -50, width: 200, height: 200, opacity: 0.18 },
  heroEyebrow: { color: '#999999', letterSpacing: 1.4, fontSize: 9, fontWeight: '800' },
  heroTitle: { fontFamily: Fonts.serif, color: '#FFFFFF', fontSize: 28, lineHeight: 32, letterSpacing: -0.8, fontWeight: '700', marginTop: 8 },
  heroTrust: { color: '#999999', fontSize: 11, fontWeight: '600', marginTop: 10 },
  heroLinks: { flexDirection: 'row', gap: 16, marginTop: 14 },
  heroLink: { color: '#FFFFFF', fontSize: 12, fontWeight: '800', textDecorationLine: 'underline' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  markTile: { width: 26, height: 26, borderRadius: 7, overflow: 'hidden', backgroundColor: '#111111' },
  markTileImage: { width: '100%', height: '100%' },
  eyebrow: { color: '#999999', letterSpacing: 1.3, fontSize: 10, fontWeight: '800' },
  form: { backgroundColor: '#F2F2F2', borderRadius: 17, padding: 17, marginTop: 12 },
  fieldLabel: { color: '#999999', letterSpacing: 1, fontSize: 10, fontWeight: '800', marginBottom: 7 },
  input: { backgroundColor: '#FFFFFF', height: 45, borderRadius: 9, paddingHorizontal: 12, color: '#111111', marginBottom: 13 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  submit: { height: 45, backgroundColor: '#111111', borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  submitDisabled: { backgroundColor: '#CCCCCC' },
  submitText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
});
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `login.tsx`.

Run: `npm run lint`
Expected: no new warnings/errors.

- [ ] **Step 3: Verify visually on native and web**

Run: `npx expo start` — check on an iOS/Android simulator (signed out): app opens to the redesigned login screen — black hero band with "Sell fast. Stock smart.", faint K watermark bleeding off the top-right corner, "How it works"/"Create a shop" links, small K tile next to "WELCOME BACK", form below. Tap both hero links and confirm they push `/about` and `/signup` per Task 4.

Run: `npx expo start --web` — navigate to `/login` from the landing page's "Log in" button. Expected: same redesigned hero band renders on web too (this file isn't platform-split, only `_layout.tsx`/`app-tabs.tsx` are), inside the existing pushed-screen-with-header presentation from `_layout.web.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(public\)/login.tsx
git commit -m "Redesign login screen with black hero band and K mark accent"
```

---

### Task 6: Full manual regression pass

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Native — signed out**

Fresh install / cleared session on simulator. Expected: app opens directly to `login` (no landing page, no tab bar). Links to "How it works" and "Create a shop" work and back navigation returns to `login`.

- [ ] **Step 2: Native — admin/staff session**

Sign in with an admin (or staff) test account, force-quit and relaunch the app. Expected: app opens directly to `/dashboard`, never showing `login` or the landing page.

- [ ] **Step 3: Native — customer session (if a test account with `role = 'customer'` exists in Supabase; otherwise skip and note it in the task result)**

Sign in with a customer-role account, relaunch. Expected: app opens to `marketplace-coming-soon`, "Log out" returns to `login`.

- [ ] **Step 4: Web — fully unchanged**

Open `expo start --web`. Expected: `/` shows the marketing landing page with the tab bar (Home / How it works / Sign up) exactly as before this plan, "Log in" button pushes the redesigned `login.tsx` (new hero band — expected, since `login.tsx` isn't platform-split) with its native-style header ("Log in", back button) still present. Confirm the tab bar itself and landing/about/signup content are pixel-identical to `main` (compare against `git diff main -- 'src/app/(public)/(tabs)/**'`, expect no changes).

- [ ] **Step 5: Run full verification suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: no errors/warnings.

Run: `npm test`
Expected: existing `src/lib/__tests__/*.test.ts` suite still passes (this feature doesn't touch any file under `src/lib/`, so this is a pure regression check).

- [ ] **Step 6: Final commit (only if Step 1-4 surfaced fixes)**

If manual verification required any code fixes, stage and commit them individually per the file they touch, following the same commit-message style as Tasks 1-5. If everything passed as implemented, there is nothing to commit in this task.
