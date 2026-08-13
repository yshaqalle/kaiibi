-- Verification for 20260828000000. Run against the local database.
-- Every block prints PASS or FAIL.

-- 1. A recipient cannot be queued twice for the same campaign.
do $$
declare v_shop uuid; v_campaign uuid; v_customer uuid; v_created_customer boolean := false;
begin
  select id into v_shop from public.shops limit 1;
  insert into public.campaigns (shop_id, name) values (v_shop, 'dup test') returning id into v_campaign;
  select id into v_customer from public.customers where shop_id = v_shop limit 1;
  if v_customer is null then
    insert into public.customers (shop_id, first_name) values (v_shop, 'Dup Test') returning id into v_customer;
    v_created_customer := true;
  end if;
  insert into public.campaign_recipients (campaign_id, customer_id) values (v_campaign, v_customer);
  begin
    insert into public.campaign_recipients (campaign_id, customer_id) values (v_campaign, v_customer);
    raise notice 'FAIL: the same customer was queued twice';
  exception when unique_violation then
    raise notice 'PASS: a duplicate recipient was refused';
  end;
  delete from public.campaigns where id = v_campaign;
  if v_created_customer then
    delete from public.customers where id = v_customer;
  end if;
end $$;

-- 2. No state anywhere claims a delivery.
select case when count(*) = 0 then 'PASS: no delivered/read state exists'
            else 'FAIL: a delivery-claiming state is allowed' end
from pg_constraint
where conname like 'campaign_recipients_state%'
  and (pg_get_constraintdef(oid) ilike '%delivered%' or pg_get_constraintdef(oid) ilike '%read%');

-- 3. Deleting a promotion keeps the campaign that advertised it.
do $$
declare v_shop uuid; v_promo uuid; v_campaign uuid; v_left integer;
begin
  select id into v_shop from public.shops limit 1;
  insert into public.promotions (shop_id, name, discount_type, discount_value, scope)
    values (v_shop, 'temp promo', 'percentage', 10, 'store') returning id into v_promo;
  insert into public.campaigns (shop_id, promotion_id, name)
    values (v_shop, v_promo, 'keeps its history') returning id into v_campaign;
  delete from public.promotions where id = v_promo;
  select count(*) into v_left from public.campaigns where id = v_campaign;
  if v_left = 1 then raise notice 'PASS: the campaign outlived its promotion';
  else raise notice 'FAIL: deleting a promotion destroyed the campaign';
  end if;
  delete from public.campaigns where id = v_campaign;
end $$;
