-- The client catalog gained a seventh palette (azure, the apple.com blue
-- #0071e3 -- see the comment on COLORS.azure in storefront-catalog.ts for why
-- that hex and not iOS systemBlue). The column's CHECK still names six, so a
-- shop picking Azure in the editor had its save refused. Same list, plus one.
alter table public.storefronts
  drop constraint storefronts_palette_check;

alter table public.storefronts
  add constraint storefronts_palette_check
  check (palette in ('ink', 'palm', 'clay', 'sea', 'saffron', 'plum', 'azure'));
