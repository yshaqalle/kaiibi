-- Notification preferences — Settings → Notifications. These are
-- preferences only: nothing in the app sends a daily summary, low-stock
-- alert, or push/email/WhatsApp notification yet, so toggling these has no
-- effect beyond being saved and read back. Real delivery (push tokens, a
-- scheduled job for summaries/threshold alerts, email/WhatsApp provider
-- integration) is tracked separately in docs/backlog.
alter table public.shops add column if not exists notify_daily_summary boolean not null default true;
alter table public.shops add column if not exists notify_large_sale boolean not null default true;
alter table public.shops add column if not exists notify_low_stock boolean not null default true;
alter table public.shops add column if not exists notify_out_of_stock boolean not null default true;
alter table public.shops add column if not exists notify_via_push boolean not null default true;
alter table public.shops add column if not exists notify_via_email boolean not null default false;
alter table public.shops add column if not exists notify_via_whatsapp boolean not null default false;
