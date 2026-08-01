# Profile: Language & Dark mode (backlog)

**Status:** Backlog — not scheduled. Currently UI-only placeholders.

**Where it lives today:** Settings → Profile (`src/components/settings/panels/profile-panel.tsx`). "Language" shows a static "English" with a no-op "Change" button; "Dark mode" is a local `useState` toggle with no persistence — neither is backed by real app behavior.

## Dark mode

The groundwork is partially there but not connected:
- `src/constants/theme.ts` already exports `Colors.dark` alongside `Colors.light`.
- `Colors.dark` is currently only used for a handful of **fixed** dark chrome elements (`ScreenHeader`, the mobile tab bar in `admin-tabs.tsx`) — explicitly *not* a user-toggleable theme. Comments in both files say so directly ("pinned to the light palette for now — no dark-mode switching yet").

What real implementation would need:
- A theme context/provider that reads a persisted preference (device storage or a `profiles`/`shops` column) and exposes the active palette app-wide.
- Most screens currently use **hardcoded hex literals** (`#111111`, `#F2F2F2`, `#999999`, etc.) rather than `Colors.light.*` tokens — this redesign's own Settings screens included. Making dark mode actually work means going through most of the app's `StyleSheet`s and replacing literals with theme tokens, not just flipping a switch in one file. This is a cross-cutting pass, not a small feature.
- Decide the persistence mechanism: local-only (device) vs. synced (a column on `profiles`) — the toggle currently lives in Settings, which suggests the latter, but that's worth confirming before starting.

## Language

No i18n library is installed (checked `package.json` — no `react-i18next`, `expo-localization`, `react-intl`, etc.), so this is starting from zero:
- Pick an i18n approach (likely `expo-localization` for device locale detection + a lightweight string-table library, or `react-i18next`).
- Extract every user-facing string in the app into translation files — a large, mechanical but wide-reaching change.
- Decide which languages to support first (Somali and/or Arabic are the obvious candidates given the app's Somaliland-focused copy elsewhere — currency defaults, receipt examples, etc.).
- Persist the chosen language (device locale default, overridable, likely stored the same way as the dark-mode preference).

## Note

Both of these are meaningfully larger than a typical Settings toggle — they're app-wide infrastructure work that happens to be *exposed* through Settings, not features contained within it. Worth scoping as their own plans rather than folding into a general "Settings Phase 2" pass.
