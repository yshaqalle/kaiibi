create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','customer')) default 'customer',
  full_name text,
  phone text,
  created_at timestamptz not null default now()
);

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  city text default 'Hargeisa',
  neighborhood text,
  contact_phone text,
  categories text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  description text,
  sku text,
  barcode text,
  brand text,
  category text,
  tags text[] not null default '{}',
  supplier_name text,
  cost_cents integer check (cost_cents is null or cost_cents >= 0),
  price_cents integer not null check (price_cents >= 0),
  stock integer not null default 0 check (stock >= 0),
  reorder_level integer check (reorder_level is null or reorder_level >= 0),
  shelf_number text,
  expiry_date date,
  batch_number text,
  image_url text,
  is_listed_online boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_shop_id_idx on public.products(shop_id);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  created_by uuid references auth.users(id),
  payment_method text not null check (payment_method in ('cash','zaad','edahab','other')),
  payment_note text,
  total_cents integer not null default 0,
  item_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index sales_shop_id_idx on public.sales(shop_id);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  unit_price_cents integer not null,
  quantity integer not null check (quantity > 0),
  line_total_cents integer not null
);
create index sale_items_sale_id_idx on public.sale_items(sale_id);

alter table public.profiles enable row level security;
alter table public.shops enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;

create policy "own profile" on public.profiles for all
  using (id = auth.uid()) with check (id = auth.uid());

create policy "own shops select" on public.shops for select using (owner_id = auth.uid());
create policy "own shops insert" on public.shops for insert with check (owner_id = auth.uid());
create policy "own shops update" on public.shops for update using (owner_id = auth.uid());
create policy "own shops delete" on public.shops for delete using (owner_id = auth.uid());

create or replace function public.owns_shop(p_shop_id uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.shops where id = p_shop_id and owner_id = auth.uid());
$$;

create policy "own products" on public.products for all
  using (owns_shop(shop_id)) with check (owns_shop(shop_id));

create policy "own sales" on public.sales for all
  using (owns_shop(shop_id)) with check (owns_shop(shop_id));

create policy "own sale_items" on public.sale_items for all
  using (exists (select 1 from public.sales s where s.id = sale_id and owns_shop(s.shop_id)));

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'role', 'customer'),
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'phone'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.complete_sale(
  p_shop_id uuid,
  p_items jsonb,
  p_payment_method text,
  p_payment_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_line integer;
  v_total_cents integer := 0;
  v_item_count integer := 0;
begin
  if not public.owns_shop(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if p_payment_method not in ('cash','zaad','edahab','other') then
    raise exception 'invalid payment method %', p_payment_method;
  end if;

  insert into public.sales (shop_id, created_by, payment_method, payment_note)
    values (p_shop_id, auth.uid(), p_payment_method, p_payment_note)
    returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid quantity in cart item';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id
      for update;

    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;
    if v_product.stock < v_qty then
      raise exception 'insufficient stock for %: has %, need %', v_product.name, v_product.stock, v_qty;
    end if;

    v_line := v_product.price_cents * v_qty;

    update public.products set stock = stock - v_qty, updated_at = now() where id = v_product.id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
      values (v_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line);

    v_total_cents := v_total_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot complete a sale with no items';
  end if;

  update public.sales set total_cents = v_total_cents, item_count = v_item_count where id = v_sale_id;
  return v_sale_id;
end;
$$;
