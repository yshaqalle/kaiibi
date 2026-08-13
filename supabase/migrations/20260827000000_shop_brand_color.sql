-- The shop's own colour, for the things it shows the world.
--
-- Shops carry a logo (shops.logo_url) and nothing else about how they look, so
-- every poster would otherwise open on the same purple and an owner would
-- re-pick their own brand every time they ran a sale. On the shop rather than
-- on each poster for exactly that reason.
--
-- Null means "we have not been told", which the poster reads as its template
-- default -- not as black. A shop that never opens Settings still gets a
-- poster that looks deliberate.
--
-- Text on it is NOT stored: it is computed from this colour's luminance (see
-- src/lib/contrast.ts). Storing both would let them drift into an unreadable
-- pair that nothing would catch until it was printed and on a door.
alter table public.shops add column brand_color text;

alter table public.shops
  add constraint shops_brand_color_is_hex
    check (brand_color is null or brand_color ~* '^#[0-9a-f]{6}$');
