-- Whether a store scans, and how.
--
-- PER STORE, not per business, because a scanner is a physical fact about a
-- counter: the flagship has a USB scanner wired to the till, the kiosk has a
-- phone, the stockroom has neither. `shop_locations` already carries this kind
-- of per-place operational config (opening hours, revenue goals), so the
-- setting belongs beside them rather than as another business-wide flag.
--
-- Two switches rather than one, because the two ways of scanning fail
-- differently and a store can easily want one without the other.

-- Camera scanning: shows the Scan buttons in POS and Inventory. Default ON --
-- it is additive (a button that opens a modal, which explains itself if there
-- is no camera) and it is the whole point of the feature, so a shop shouldn't
-- have to go find a setting to get it.
alter table public.shop_locations
  add column if not exists barcode_scanning_enabled boolean not null default true;

-- Hardware "wedge" scanners -- the USB/Bluetooth kind that pretend to be a
-- keyboard. Default OFF, deliberately, and this is the important half:
-- supporting them means listening to every keystroke on the page to spot a
-- fast burst. Where no such scanner exists that listener is pure risk and no
-- benefit, so a store opts in only once it actually has one plugged in.
alter table public.shop_locations
  add column if not exists hardware_scanner_enabled boolean not null default false;

comment on column public.shop_locations.barcode_scanning_enabled is
  'Show camera-based barcode scanning at this store.';
comment on column public.shop_locations.hardware_scanner_enabled is
  'This store has a USB/Bluetooth keyboard-wedge scanner; enables global keystroke capture.';
