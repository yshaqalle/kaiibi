-- Finishing a sale should show the receipt and let the cashier choose what to
-- do with it, not decide for them.
--
-- 0031 turned "Print receipt" and "Send via WhatsApp" on for every shop and
-- made them the default for new ones. The effect at the till is that completing
-- a sale immediately opens the browser's print dialog -- a modal window that
-- covers the Print / Email / WhatsApp buttons the receipt view offers -- and,
-- when the customer has a phone number, opens WhatsApp as well. Two things
-- seize the moment before anyone has decided anything, and on web the print
-- dialog has to be dismissed before the receipt is even visible.
--
-- This reverses that, using 0031's own reasoning in the other direction: it
-- justified force-setting every row on the grounds that no shop had
-- deliberately opted out. By the same token none deliberately opted in -- the
-- setting was applied to them -- so resetting is not overriding a choice
-- anybody made.
--
-- The settings themselves stay. Auto-print is genuinely wanted at a busy
-- counter with a thermal printer attached, and auto-WhatsApp where the shop
-- always messages the receipt. They are just opt-in now, in Settings -> Receipt,
-- rather than something a shop discovers by having its POS behave oddly.
--
-- A shop that HAS since turned either on will be reset by this and will need to
-- turn it back on. That is the one real cost, and it is preferred to leaving
-- every other shop with a print dialog they did not ask for.

alter table public.shops alter column receipt_auto_print set default false;
alter table public.shops alter column receipt_auto_whatsapp set default false;
update public.shops set receipt_auto_print = false, receipt_auto_whatsapp = false;
