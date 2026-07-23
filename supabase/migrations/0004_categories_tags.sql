create table public.categories (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (shop_id, name)
);
create index categories_shop_id_idx on public.categories(shop_id);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (shop_id, name)
);
create index tags_shop_id_idx on public.tags(shop_id);

alter table public.categories enable row level security;
alter table public.tags enable row level security;

create policy "own categories" on public.categories for all
  using (owns_shop(shop_id)) with check (owns_shop(shop_id));

create policy "own tags" on public.tags for all
  using (owns_shop(shop_id)) with check (owns_shop(shop_id));

-- Renaming/deleting a category or tag must cascade to every product that
-- currently references it by name (products.category/tags are free text,
-- not foreign keys), so these are RPCs rather than plain table writes —
-- the app should never update products.category/tags directly for a
-- rename/delete, only through here, or the two can drift out of sync.

create or replace function public.rename_category(p_shop_id uuid, p_old_name text, p_new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.owns_shop(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  update public.categories set name = p_new_name where shop_id = p_shop_id and name = p_old_name;
  update public.products set category = p_new_name, updated_at = now() where shop_id = p_shop_id and category = p_old_name;
end;
$$;

create or replace function public.delete_category(p_shop_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.owns_shop(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  delete from public.categories where shop_id = p_shop_id and name = p_name;
  update public.products set category = null, updated_at = now() where shop_id = p_shop_id and category = p_name;
end;
$$;

create or replace function public.rename_tag(p_shop_id uuid, p_old_name text, p_new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.owns_shop(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  update public.tags set name = p_new_name where shop_id = p_shop_id and name = p_old_name;
  update public.products set tags = array_replace(tags, p_old_name, p_new_name), updated_at = now()
    where shop_id = p_shop_id and p_old_name = any(tags);
end;
$$;

create or replace function public.delete_tag(p_shop_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.owns_shop(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  delete from public.tags where shop_id = p_shop_id and name = p_name;
  update public.products set tags = array_remove(tags, p_name), updated_at = now()
    where shop_id = p_shop_id and p_name = any(tags);
end;
$$;

grant select, insert, update, delete on public.categories to authenticated;
grant select, insert, update, delete on public.tags to authenticated;
grant execute on function public.rename_category(uuid, text, text) to authenticated;
grant execute on function public.delete_category(uuid, text) to authenticated;
grant execute on function public.rename_tag(uuid, text, text) to authenticated;
grant execute on function public.delete_tag(uuid, text) to authenticated;

-- Backfill: seed the new tables from whatever categories/tags are already
-- in use on existing products, so shops with products don't start with an
-- empty (and misleadingly "no categories exist yet") settings screen.
insert into public.categories (shop_id, name)
  select distinct shop_id, category from public.products where category is not null
  on conflict (shop_id, name) do nothing;

insert into public.tags (shop_id, name)
  select distinct shop_id, unnest(tags) from public.products
  on conflict (shop_id, name) do nothing;
