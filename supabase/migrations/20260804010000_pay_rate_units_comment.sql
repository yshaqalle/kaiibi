-- Records what pay_rate_cents means. It previously had no stated unit: the UI
-- labelled it annual while computePayrollDraft divided it by a nominal 30
-- days, so a salary entered as an annual figure was paid at roughly 12x.
--
-- Monthly is now canonical for salaried pay. Documentation only -- no schema
-- change is needed, because the week/month/year selector on the pay form is
-- an entry converter rather than stored state, so there is no second column
-- that can disagree with this one.

comment on column public.shop_members.pay_rate_cents is
  'Cents. Per hour when pay_type = hourly; per month when salary; per pay run when fixed.';

comment on column public.payroll_run_lines.pay_rate_cents is
  'Frozen copy of shop_members.pay_rate_cents at draft time. Same units.';
