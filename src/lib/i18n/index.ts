import { en, type MessageKey, type Messages } from '@/lib/i18n/messages.en';
import { so } from '@/lib/i18n/messages.so';

// Translation as pure functions over already-loaded string tables.
//
// Deliberately free of React and of every platform API -- the same split as
// location-selection.ts beside locations.ts, and expense-reporting.ts beside
// expenses.ts. Which language a visitor gets is decided here, so it has to be
// unit-testable without a DOM, and `hooks/use-locale.tsx` is only the React
// wrapper around it. Anything touching storage lives in ./locale-storage.

export type Locale = 'en' | 'so';

export const LOCALES: readonly Locale[] = ['en', 'so'];

// Matches the dotted convention already in use for device-scoped preferences
// (`kaiibi.activeLocationId` in hooks/use-auth.tsx).
export const LOCALE_STORAGE_KEY = 'kaiibi.locale';

const TABLES: Record<Locale, Messages> = { en, so };

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'so';
}

// The language a visitor should land in.
//
// A saved choice always wins: someone who picked English on a Somali phone
// meant it, and re-deciding from the device on every load would silently undo
// them.
//
// Otherwise the device's PRIMARY SUBTAG decides -- `so`, `so-SO`, `so-DJ` are
// all Somali. Compared as a whole subtag rather than with `startsWith('so')`,
// which also matches `son-ML` (Songhai) and would hand a Songhai speaker a
// language they don't read.
export function resolveInitialLocale(saved: string | null, deviceLanguage: string | null): Locale {
  if (isLocale(saved)) return saved;
  const primary = (deviceLanguage ?? '').toLowerCase().split(/[-_]/)[0];
  return primary === 'so' ? 'so' : 'en';
}

// `{name}` placeholders are filled from `vars`. A token with no matching var is
// left as written rather than blanked: a visible `{year}` is a bug report,
// while an empty gap looks like a missing translation.
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  );
}

// Falls back to English on an empty Somali value. Types already make a MISSING
// key impossible (see messages.so.ts), so this only catches a key someone left
// as '' while translating -- better a readable English string than a blank.
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>
): string {
  const value = TABLES[locale][key];
  return interpolate(value || en[key], vars);
}

export type { MessageKey, Messages };
