-- Branding removal is a CAPABILITY on the plan row, not a key comparison in
-- code -- plans get retired and hopped to successors (20260824000100), so a
-- planKey === 'pro' test breaks the first time Pro is renamed. Default false:
-- the perk is HIDING the mark, so an unknown or missing plan shows it.
alter table public.plans
  add column hide_storefront_branding boolean not null default false;

update public.plans set hide_storefront_branding = true where key = 'pro';
