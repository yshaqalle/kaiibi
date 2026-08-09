# Owner as a team member

**Date:** 2026-08-08
**Status:** Approved, not yet implemented

## Problem

The owner of a shop is not a team member. They are identified only by
`shops.owner_id`, and every permission check ORs `owns_shop()` on top of the
`shop_members` lookup — so they hold every permission while belonging to
nothing.

The consequence is that the owner cannot be *operated on* like a person. They
do not appear in the team list, cannot be given a shift, and cannot be assigned
to a register. In a one-person shop — which is most shops on the Free plan —
that means the schedule and the register assignment features are unusable by
the only person who works there.

A UI-only fix is not available. `shifts.shop_member_id` and
`registers.shop_member_id` are foreign keys into `shop_members`, so anything
that can be scheduled or handed a till must be a real row in that table.

## Decision

Give the owner an ordinary `shop_members` row. Their authority keeps coming
from `shops.owner_id`, so the row grants nothing and takes nothing away — it
exists so the rest of the app has something to point a foreign key at.

The owner **counts against the plan's staff limit**, and both capped plans gain
a seat to absorb it:

| Plan | `limits.staff` before | after |
|------|----------------------|-------|
| Free | 2 | 3 |
| Standard | 10 | 11 |
| Trial, Pro | uncapped | uncapped |

This keeps the counter trigger untouched — a seat is a seat, whoever fills it —
and keeps the pricing page honest: a Standard shop still gets ten employees
alongside its owner.

## Database

### 1. An `Owner` role per shop

`shop_members.role_id` is NOT NULL, so the row needs a role to point at.
`Owner` is seeded alongside the existing `Cashier` and `Manager` defaults.

It is a **label only**. The owner's permissions come from `owner_id` and are
unaffected by what this role's `permissions` array contains, so it is seeded
with the full catalog purely so the Roles screen doesn't show the owner holding
nothing. `roles` is `ON DELETE RESTRICT`, so it cannot be deleted while the
owner's row references it.

### 2. Seeding on shop creation, not just backfill

Today the default roles exist only because migration `0020_default_roles.sql`
inserted them for shops that existed when it ran. **Nothing seeds roles for a
shop created since** — the local database's one shop has zero roles, which is
this gap showing. `createShop()` in `src/lib/shops.ts` seeds currencies and the
primary location from client code and never touches roles.

This feature cannot rely on a role that may not exist, so seeding moves into an
`AFTER INSERT` trigger on `shops`, mirroring the existing `shops_start_trial`
trigger. One trigger function seeds:

- the three default roles (`Cashier`, `Manager`, `Owner`), and
- the owner's `shop_members` row, pointed at `Owner`.

Putting it in a trigger rather than in `createShop()` means it holds for every
path that creates a shop, including the platform portal and any future one.

The owner's `full_name` and `email` come from `profiles.full_name` and
`auth.users.email` (readable from a `SECURITY DEFINER` function), with
`coalesce(profiles.full_name, auth.users.raw_user_meta_data->>'full_name',
split_part(email, '@', 1))` as the fallback chain — at signup the shop may be
created before the profile row exists.

`shop_member_locations` is left empty for the owner. An empty assignment means
*every* store (migration `20260814000000`), which is what an owner should have.

### 3. Backfill for existing shops

For each existing shop: seed any missing default roles, then insert the owner's
member row. `unique (shop_id, user_id)` makes it idempotent.

The `shop_members_limit` trigger is disabled for the duration of the backfill
and `shop_usage_counters` is recomputed from actual counts afterwards, rather
than relying on the limit bump landing first. A shop that is somehow already at
or over its cap must not turn a data migration into a failed deploy.

### 4. The owner's row is protected

A `BEFORE UPDATE OR DELETE` trigger on `shop_members` raises if the target row
belongs to the shop's owner and the change would delete it or set `active` to
false. An owner who deactivates themselves would lose the /me tab and their own
schedule while still owning the shop — an unrecoverable state reachable from an
ordinary-looking button.

Changing the owner's *role* stays allowed. It is a label, and nothing depends
on it.

## Application

Most of the app needs no change: `list_shop_staff` already returns every
`shop_members` row for the shop, so the owner appears in the team list, the
schedule's staff column, the bulk shift modal and the register assignment
picker the moment the row exists.

What does change:

- **`myMembership` resolves for owners.** It is currently null for them by
  design (`src/hooks/use-auth.tsx`). Everything gated on it — the /me tab
  (`people.tsx`), the People nav item, `sessionMember ?? myMembership` in the
  POS — starts working for the owner. This is the point of the change, but the
  comment at `use-auth.tsx:40` describing the null must be corrected or it will
  mislead the next reader.
- **Owner badge in the team list**, and the deactivate/delete actions hidden
  for that row (`team-member-edit-modal.tsx`). The database trigger is the
  enforcement; hiding the buttons is so nobody meets the error.
- **Profile name changes sync**, via a trigger on `profiles` rather than a
  second write in the profile panel — every path that renames a profile then
  keeps the roster right, not just the one screen that remembered to. Only the
  owner's row follows the profile: a staff member's roster name belongs to
  whoever manages the team, and letting them rewrite it from their own profile
  would take that away.

### Known consequences, accepted

- The owner appears in payroll with no pay set (`pay_type` null), the same as
  any member whose pay has not been entered. An owner who pays themselves can
  now record it, which is an improvement, not a regression.
- The Billing panel's staff usage now includes the owner. The limit bump is
  what keeps that from reading as a downgrade.
- Ownership transfer is out of scope. Nothing in the app does it today; when it
  is built it will have to move the member row alongside `owner_id`.

## Testing

`supabase/tests/verify-owner-membership.sql`, following the existing
`verify-*.sql` convention — every claim here is a trigger, a constraint or a
policy, which is the half of the system the Jest suite cannot reach. Seven
sections, ending on the one the migration exists for: the owner can be given a
shift.

Two existing scripts assert the *old* truth and are updated alongside, not
worked around:

- `verify-accounting-writes.sql` created a member row for the owner; it now
  sets pay on the row that already exists.
- `verify-registers.sql` asserted an owner-run session carries `opened_by` and
  a null member, and that an owner's mobile register is keyed by `user_id`.
  Both now expect the membership. The nullable column and the `opened_by`
  fallback stay — a session must still name whoever ran it — but an owner is no
  longer the case that exercises them.

`verify-loyalty.sql` fails on this branch for unrelated reasons; it failed
identically before this change.
