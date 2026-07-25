-- Brands as a real, editable table — same treatment as categories/tags
-- (migration 0004): previously `products.brand` was pure free text with no
-- shared list, no rename-cascade, and no Settings UI.
create table public.brands (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (shop_id, name)
);
create index brands_shop_id_idx on public.brands(shop_id);

alter table public.brands enable row level security;

create policy "own brands" on public.brands for all
  using (owns_shop(shop_id)) with check (owns_shop(shop_id));

-- Same reasoning as rename_category/delete_category: products.brand is free
-- text, not a foreign key, so renaming/deleting a brand must cascade
-- explicitly rather than relying on referential integrity.
create or replace function public.rename_brand(p_shop_id uuid, p_old_name text, p_new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.owns_shop(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  update public.brands set name = p_new_name where shop_id = p_shop_id and name = p_old_name;
  update public.products set brand = p_new_name, updated_at = now() where shop_id = p_shop_id and brand = p_old_name;
end;
$$;

create or replace function public.delete_brand(p_shop_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.owns_shop(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  delete from public.brands where shop_id = p_shop_id and name = p_name;
  update public.products set brand = null, updated_at = now() where shop_id = p_shop_id and brand = p_name;
end;
$$;

grant select, insert, update, delete on public.brands to authenticated;
grant execute on function public.rename_brand(uuid, text, text) to authenticated;
grant execute on function public.delete_brand(uuid, text) to authenticated;

-- Backfill from whatever brands are already in use on existing products.
insert into public.brands (shop_id, name)
  select distinct shop_id, brand from public.products where brand is not null
  on conflict (shop_id, name) do nothing;
