# Notification delivery (backlog)

**Status:** Backlog — not scheduled. The Settings → Notifications toggles are now real (persist to `shops.notify_*`, migration 0029), but nothing in the app actually sends a notification based on them yet.

**Where it lives today:** `src/components/settings/panels/notifications-panel.tsx`. Every toggle saves and reloads correctly — this doc is about the missing other half: actually triggering a push/email/WhatsApp send.

## What this covers

- **Daily sales summary** — sent every evening.
- **Large sale alert** — a single sale exceeding $100.
- **Low stock warning** / **Out of stock** — inventory threshold alerts.
- **Delivery channels** — Push notifications, Email, WhatsApp.

## Why this is a separate, bigger project

Wiring Receipt and Payments to "real" meant gating or reading a preference that an *existing* capability already used (the POS checkout, the receipt renderer). Notifications has no existing capability to gate — there is currently:
- No push notification setup at all (no `expo-notifications`, no push token registration/storage).
- No scheduled job infrastructure (no `pg_cron`, no scheduled Edge Function) to compute a "daily summary" or check stock levels on a timer.
- No email provider integration (e.g. Resend, Postmark, SES).
- No WhatsApp Business API integration — the existing WhatsApp usage in this app (`receipt-modal.tsx`) just opens a `wa.me` link for the *user* to send manually; it's not a server-initiated message.

## What real implementation would need

- **Push:** add `expo-notifications`, register/store device push tokens (likely a `push_tokens` table keyed by user/shop), and a way to actually call Expo's push API from the backend.
- **Scheduling:** a Supabase `pg_cron` job or scheduled Edge Function that runs daily (summary) and/or periodically (stock thresholds, large-sale checks against recent sales) per shop, respecting each shop's `notify_*` columns.
- **Email:** pick and integrate a transactional email provider, plus template design for the summary/alert content.
- **WhatsApp:** WhatsApp Business API (e.g. via Twilio or Meta directly) — a real ops/cost dependency, separate from the free `wa.me` link trick used elsewhere.
- Decide alert thresholds precisely (the "$100" large-sale figure and low-stock threshold are currently just copy in the mock, not configurable anywhere — may want to make these shop-configurable numbers rather than hardcoded).

## Note

This is meaningfully larger than the Settings screen itself — closer to its own multi-part project (push infra + scheduled jobs + at least one, likely two, third-party service integrations) than a quick follow-up.
