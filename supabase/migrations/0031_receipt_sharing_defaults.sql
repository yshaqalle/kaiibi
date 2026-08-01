-- "Send via WhatsApp" and "Print receipt" (Settings → Receipt) now default
-- to on, rather than off as set in migration 0026. Updates existing rows too
-- (not just the column default for future shops), since there's no shop
-- that has deliberately opted out of this yet.
alter table public.shops alter column receipt_auto_whatsapp set default true;
alter table public.shops alter column receipt_auto_print set default true;
update public.shops set receipt_auto_whatsapp = true, receipt_auto_print = true;
