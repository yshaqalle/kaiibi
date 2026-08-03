-- Draft warnings were computed and then thrown away: computePayrollDraft set a
-- `warning` on every line needing a human decision, createPayrollRun didn't
-- persist it, no column held it, and the run editor rendered nothing. The only
-- readers were unit tests, which made payroll-reporting.ts's "surfaced in the
-- editor so it's corrected before posting" comment untrue.
--
-- Both columns are frozen at draft time, exactly like pay_type/pay_rate_cents:
-- recomputing a warning at display time would let a later pay rise restate what
-- a past run appears to have flagged.
--
-- Additive and defaulted, so every already-posted run keeps warning_blocking =
-- false and stays postable/unpostable exactly as before.

alter table public.payroll_run_lines
  add column warning text null,
  add column warning_blocking boolean not null default false;

comment on column public.payroll_run_lines.warning is
  'Frozen at draft time: why this line needs a human decision. Never recomputed.';

comment on column public.payroll_run_lines.warning_blocking is
  'True when the warning must be resolved before posting. post_payroll_run enforces it against amount_cents = 0, so entering an amount clears the block while the warning survives as history.';
