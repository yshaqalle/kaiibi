import { Redirect } from 'expo-router';

// Native only — web's landing content lives in `index.web.tsx`, moved here
// unchanged. On native, nothing links to `/` anymore: the login screen's
// own hero band (see Task 5) replaces the marketing pitch this page used
// to carry, and no other screen references it. This file exists only so
// the literal URL `/` resolves somewhere sane — a bare redirect to
// `/login` — instead of falling through to stale landing content. See
// `(public)/_layout.tsx` for why this file, not a Stack `initialRouteName`,
// is the actual login-first mechanism.
export default function IndexRedirect() {
  return <Redirect href="/login" />;
}
