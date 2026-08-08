-- Where a register actually stands, and anything else about it worth knowing.
--
-- Until now the only place to say that was the NAME, which is why the design
-- mockups reached for "Register 2 — pharmacy side". But the name is rendered
-- everywhere the space is tightest: the POS register bar (one line, beside two
-- buttons), session history rows, Dashboard attention rows. A name long enough
-- to describe a position breaks all three.
--
-- So the two jobs are split, and the split is the point:
--
--   name -- IDENTITY. What staff call it when they point at it. Short, because
--           it appears in every one of those tight places.
--   note -- CONTEXT. Where it stands, and what a new cashier needs to know
--           about it. Appears only in Settings and the session detail sheet,
--           where there is room for prose.
--
-- The failure to guard against is identity drifting into the note: a register
-- called "Register 2" whose note says "actually the pharmacy one" leaves the
-- name useless on every screen that has room for nothing else. The field's hint
-- in the editor says so.
--
-- Deliberately free text and not a structured position. Where a till stands is
-- prose -- "third counter from the door", "upstairs by the fridge" -- and any
-- schema for it would be wrong for the second shop that tried to use it. Same
-- reasoning migration 20260821000000 gives for leaving merchant ids free text.

alter table public.registers
  add column if not exists note text;

comment on column public.registers.note is
  'Free-text context: where this register stands, and anything a cashier needs
   to know about it. Not identity -- that is `name`, which renders in the POS
   bar and every session row.';
