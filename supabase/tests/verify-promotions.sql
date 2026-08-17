-- @requires-populated-database: reads an existing shop rather than building its own fixture.
-- Verification for 20260826000000 and 20260826000100. Run against a database
-- with at least one shop and one completed sale. Each block prints PASS/FAIL.

-- 1. The window constraint refuses a backwards window.
do $$
begin
  begin
    insert into public.promotions (shop_id, name, discount_type, discount_value, scope, starts_at, ends_at)
    values ((select id from public.shops limit 1), 'backwards', 'percentage', 10, 'store',
            '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z');
    raise notice 'FAIL: a backwards window was accepted';
  exception when check_violation then
    raise notice 'PASS: backwards window refused';
  end;
end $$;

-- 2. Existing rows are untouched: everything auto-applies, nothing is windowed.
select case when count(*) = 0 then 'PASS: no pre-existing row was windowed or archived'
            else 'FAIL: ' || count(*) || ' pre-existing rows changed' end
from public.promotions
where auto_apply is not true or starts_at is not null or ends_at is not null or archived_at is not null;

-- 3. A sale item keeps its promotion name after the promotion is deleted.
--    (Run after 20260826000100. Substitute a real sale_item id.)
select 'Check by hand: delete a used promotion, then confirm '
       'select promotion_id, promotion_name from sale_items where id = ... '
       'shows a null id and an intact name.' as note;
