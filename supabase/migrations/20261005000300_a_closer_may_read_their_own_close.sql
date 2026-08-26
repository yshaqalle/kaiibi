-- The By column on Close a Period, for the reader that screen was widened for.
--
-- ## THE GAP, EXACTLY
--
-- 20261004000000 widened `list_accounting_periods()` from `ledger.view` to
-- `ledger.view OR ledger.close`, because a role holding `ledger.close` ALONE is
-- one insert away and the Close a Period screen is gated on exactly that
-- permission. It reached the screen and the first call refused it.
--
-- That fixed the read that RAISES. It did not fix the read that goes quiet.
-- `listPeriodCloseEvents()` (src/lib/periods.ts) reads `accounting_audit_log`
-- DIRECTLY, under RLS, and that table's only policy is
--
--   using (has_shop_permission(shop_id, 'ledger.view'))
--
-- RLS filters silently; it does not raise. So the `ledger.close`-only reader
-- gets zero rows, `events` stays an empty Map, and closedByLabel() returns '—'
-- for every closed month -- the screen that migration widened the gate for
-- still cannot show its own By column, and nothing anywhere says why.
--
-- ## THE FIX: MAKE THE TWO GATES AGREE, AND NO WIDER
--
-- The alternative considered was returning the actor and `forced` as columns of
-- list_accounting_periods(), which already reads them under `security definer`.
-- That is a bigger change -- a new pair of columns on a shipped RPC, a second
-- place the "who closed this" rule lives, and a second thing to keep in step
-- with the audit log -- to fix a read that is correct apart from its gate.
--
-- So the policy learns the same predicate the RPC already uses, and NARROWLY:
-- `ledger.close` opens `subject_table = 'accounting_periods'` and nothing else.
-- A closer does not thereby gain the journal-entry and journal-line audit
-- history, which is `ledger.view`'s to give. The two halves of the screen now
-- answer the same reader, which is the whole of the intent, and the widening
-- stops at the rows that screen draws.
--
-- has_shop_permission twice rather than has_any_shop_permission once, because
-- the two arms are not symmetric: `ledger.view` sees every row and
-- `ledger.close` sees one table's.
drop policy if exists "read accounting_audit_log" on public.accounting_audit_log;

create policy "read accounting_audit_log" on public.accounting_audit_log for select
  using (
    has_shop_permission(shop_id, 'ledger.view')
    or (subject_table = 'accounting_periods' and has_shop_permission(shop_id, 'ledger.close'))
  );
