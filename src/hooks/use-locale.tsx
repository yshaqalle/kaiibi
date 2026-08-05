import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import {
  resolveInitialLocale,
  translate,
  type Locale,
  type MessageKey,
} from '@/lib/i18n';
import {
  readStoredLocaleAsync,
  readStoredLocaleSync,
  writeStoredLocale,
} from '@/lib/i18n/locale-storage';

// Which language the UI is in. Same shape as AuthProvider/useAuth in
// hooks/use-auth.tsx, and mounted ABOVE it in app/_layout.tsx: language does
// not depend on a session, and the public language bar has to render correctly
// while auth is still resolving.
//
// Somali is written in Latin script, so nothing here (or anywhere else) needs
// I18nManager or RTL handling. If a future locale does, that is the moment to
// add it -- not now, speculatively.

type LocaleState = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Look up `key` in the active locale, filling any `{name}` placeholders. */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
};

const LocaleContext = createContext<LocaleState | null>(null);

// The device's preferred language, as a BCP-47 tag. Web only: nothing under
// (admin) is translated yet, so native has no device preference worth reading,
// and expo-localization would be a native module added for no present benefit.
function deviceLanguage(): string | null {
  if (Platform.OS !== 'web') return null;
  return navigator.language ?? null;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  // Resolved synchronously so the FIRST paint is already in the right
  // language. See lib/i18n/locale-storage.ts for why this cannot go through
  // AsyncStorage on web.
  const [locale, setLocaleState] = useState<Locale>(() =>
    resolveInitialLocale(readStoredLocaleSync(), deviceLanguage())
  );

  // Native's storage is async, so its saved choice arrives a frame late. That
  // is harmless today -- no native screen is translated except the public
  // ones, and those mount after this resolves.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    readStoredLocaleAsync().then((saved) => {
      if (cancelled) return;
      const resolved = resolveInitialLocale(saved, null);
      setLocaleState((current) => (current === resolved ? current : resolved));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Web only: the document itself carries the language, for screen readers and
  // for the browser's own translate prompt. The title moves with it because
  // `web.output: "single"` means it is only ever set client-side.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    document.documentElement.lang = locale;
    document.title = translate(locale, 'meta.title');
  }, [locale]);

  // Persisting is fire-and-forget, like setActiveLocation in use-auth.tsx: a
  // storage failure must not stop the UI from switching.
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStoredLocale(next);
  }, []);

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale]
  );

  const value = useMemo<LocaleState>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used within LocaleProvider');
  return context;
}
