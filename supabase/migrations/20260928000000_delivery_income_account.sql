-- 4300 Delivery Income: a place for storefront delivery revenue to land that
-- is not 4000 Sales Revenue.
--
-- Delivery is revenue that carries no cost of sales -- there is no COGS line
-- for a boda ride across town. Posting it into 4000 mixes income with no
-- matching COGS into goods revenue and quietly flatters gross margin on
-- every report the accounting work already built: a shop reading its own P&L
-- would conclude its products earn more than they do. A separate revenue
-- account keeps that number honest without adding a seventh account type --
-- see the header of 20260904000100_chart_of_accounts.sql for why is_contra is
-- a flag rather than a type of its own. 4300 is NOT contra: 4100 Sales
-- Returns and 4200 Discounts Given next to it reduce revenue on purpose, and
-- getting this one backwards would subtract delivery income from the shop's
-- takings instead of adding to it.
--
-- Reproduced verbatim from 20260904000100_chart_of_accounts.sql's
-- default_chart_of_accounts(), with exactly one change: the 4300 row added
-- after 4200. CREATE OR REPLACE FUNCTION replaces the body both callers
-- already point at:
--   * the seed_shop_defaults() trigger, unchanged, seeds it into every shop
--     created from here on;
--   * the backfill below reaches every shop that exists already, the same
--     way 20260904000100's own backfill did -- on conflict do nothing, so a
--     shop with a complete chart gains exactly the one row it is missing and
--     a shop with no chart at all is unaffected by this migration (it is not
--     supposed to have one; the trigger seeds it at creation).
create or replace function public.default_chart_of_accounts()
returns table (code text, name text, type text, is_contra boolean)
language sql immutable set search_path = public as $$
  values
    ('1000'::text, 'Cash on Hand'::text,            'asset'::text,         false),
    ('1010',       'Bank',                          'asset',               false),
    ('1020',       'Mobile Money — Zaad',           'asset',               false),
    ('1021',       'Mobile Money — eDahab',         'asset',               false),
    ('1100',       'Accounts Receivable',           'asset',               false),
    ('1200',       'Inventory',                     'asset',               false),
    ('1500',       'Equipment',                     'asset',               false),
    ('1510',       'Furniture and Fittings',        'asset',               false),
    ('1590',       'Accumulated Depreciation',      'asset',               true),
    ('2000',       'Accounts Payable',              'liability',           false),
    ('2100',       'Sales Tax Payable',             'liability',           false),
    ('2200',       'Wages Payable',                 'liability',           false),
    ('2300',       'Loyalty Points Liability',      'liability',           false),
    ('3000',       'Owner''s Capital',              'equity',              false),
    ('3100',       'Owner''s Draw',                 'equity',              true),
    ('3900',       'Retained Earnings',             'equity',              false),
    ('4000',       'Sales Revenue',                 'revenue',             false),
    ('4100',       'Sales Returns',                 'revenue',             true),
    ('4200',       'Discounts Given',               'revenue',             true),
    ('4300',       'Delivery Income',               'revenue',             false),
    ('5000',       'Cost of Goods Sold',            'cost_of_sales',       false),
    ('5100',       'Inventory Shrinkage',           'cost_of_sales',       false),
    ('6000',       'Rent',                          'expense',             false),
    ('6100',       'Utilities',                     'expense',             false),
    ('6200',       'Salaries and Wages',            'expense',             false),
    ('6300',       'Marketing',                     'expense',             false),
    ('6400',       'Supplies',                      'expense',             false),
    ('6500',       'Transport and Delivery',        'expense',             false),
    ('6600',       'Maintenance and Repairs',       'expense',             false),
    ('6700',       'Fees and Charges',              'expense',             false),
    ('6800',       'Depreciation',                  'expense',             false),
    ('6900',       'Other',                         'expense',             false);
$$;

-- Shops that already exist. Same guard as 20260904000100's own backfill: on
-- conflict do nothing means a shop that already has every other account
-- gains only 4300, and re-running this migration is free.
insert into public.accounts (shop_id, code, name, type, is_contra)
  select s.id, c.code, c.name, c.type, c.is_contra
    from public.shops s
   cross join public.default_chart_of_accounts() c
on conflict (shop_id, code) do nothing;
