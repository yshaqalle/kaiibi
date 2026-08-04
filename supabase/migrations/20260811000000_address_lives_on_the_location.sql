-- One address, in one place.
--
-- 20260808000000 gave every shop a primary "Main" location carrying a COPY of
-- the shop's city/neighborhood/contact_phone, and 20260809000000 made receipts
-- read the location. That left the same address editable in two screens with
-- only one of them deciding anything: an owner editing Settings -> Store would
-- see the field accept the change and the receipt keep printing the old
-- address, because the location row still won the `location ?? shop` fallback.
-- Two writable copies of one fact always drift; the only question is when.
--
-- So the shop stops having an address at all. A business does not have a
-- street -- its branches do, and a shop with one branch simply has one. The
-- Store settings panel now edits the primary location's address directly, so
-- the single-branch shops that are the norm see no change and never have to
-- think about locations; Locations is where a SECOND branch gets added.
--
-- The data is already safe: 20260808000000 copied these three columns into the
-- primary location before anything read them, and that migration runs first.
-- This drop removes the stale duplicate, not the only copy.
--
-- The rejected alternative was keeping these as the business's registered/HQ
-- details, distinct from where it trades. That is a real distinction for a
-- large chain, but for the shops this serves it would mean typing the same
-- address twice on day one to serve a case none of them have. A shop that
-- genuinely needs it can add a location named "Office" and mark it closed.

alter table public.shops drop column city;
alter table public.shops drop column neighborhood;
alter table public.shops drop column contact_phone;
