#!/usr/bin/env bash
#
# The one check in this directory that needs TWO DATABASE SESSIONS.
#
# ## Why it is not a .sql file like everything else beside it
#
# The defect it exists for cannot be reproduced from one session, and a serial
# test passes against the broken code: run_depreciation twice in a row already
# returned 6 then 0, and did so throughout the whole period the bug was live.
# What was wrong was the INTERLEAVING.
#
#   run_depreciation posts a month's journal entry BEFORE it writes that month's
#   charge rows, and it is VOLATILE -- in READ COMMITTED every statement inside
#   it takes a fresh snapshot. So the serialisation point was never the unique
#   index on (asset_id, charge_month): it was the per-shop reference counter
#   inside post_journal_entry, which is taken AFTER the decision to post.
#
#     1. Runs A and B both evaluate the `due` CTE for month M. Both decide M is
#        due. Neither sees the other.
#     2. A posts M's entry and writes M's charge rows. B blocks on the counter.
#     3. A commits.
#     4. B wakes and posts ITS OWN entry for M -- a second Dr 6800 / Cr 1590.
#     5. B's charge-row `insert ... where not exists` re-evaluates under a NEW
#        snapshot, sees A's rows, and inserts NOTHING. No unique violation is
#        raised. B commits.
#
#   Measured before the fix, twelve assets six months old, two overlapping calls:
#
#     A returned 6   B returned 1   (neither raised)
#     entries: 7 | months: 6 | 1590: -840000 | charges: 720000
#
#   And the cash-flow proof still TIED, because a duplicate charge moves 1590 by
#   -X and 6800 by +X and `investing = -(1500-1599) - 6800` nets it to zero.
#   Wrong AND balanced is the failure mode this project keeps shipping, so the
#   test for it has to be the race and not a consequence of it.
#
# Trying dblink so the script could stay .sql got as far as:
#
#     ERROR:  password or GSSAPI delegated credentials required
#     DETAIL: Non-superusers may only connect using credentials they provide
#
# -- `postgres` is not a superuser on a Supabase stack and the local stack
# authenticates without a password, which is exactly the combination
# dblink_connect refuses. So: two psql processes, driven through FIFOs.
#
# ## The fixture is COMMITTED, which nothing else here does
#
# It has to be: an uncommitted fixture is invisible to the second session, and
# the second session must COMMIT for the duplicate entry to appear. So this
# script builds two shops, races them, asserts, and deletes them again -- on
# success, on assertion failure, and on interrupt. `shops` cascades to
# everything, and `finish` runs from a trap.
#
# ## Both shops are used, and they interleave
#
# Shop TWO is not scenery. It has its own live assets, acquired in the same
# months, and its own depreciation is run BETWEEN the two racing calls on shop
# ONE -- so a lock keyed on anything coarser than the shop (a table lock, a
# constant advisory key) would serialise it too and this script would still pass
# while month-end for every shop on the instance queued behind every other. The
# final assertions read both.
#
# Usage: bash supabase/tests/verify-depreciation-concurrency.sh
# Prints ALL CHECKS PASSED, which is what run-all.sh greps for.

set -uo pipefail

DB="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
OWNER_ONE='9a5f1c00-0000-4000-8000-000000000001'
OWNER_TWO='9a5f1c00-0000-4000-8000-000000000002'
WORK="$(mktemp -d)"
FAILED=0

q() { psql "$DB" -qAt -c "$1"; }

# The same, but as a signed-in member: every RPC here gates on
# has_shop_permission, which reads auth.uid(), which reads request.jwt.claims.
# A plain psql session has none and every call refuses.
# In one transaction, because `set_config(..., true)` is transaction-local and a
# psql session runs each statement in its own transaction otherwise.
q_as() {
  psql "$DB" -qAt <<SQL | tail -1
begin;
-- Bounded, so a call that queues forever fails this script instead of hanging
-- the whole suite behind it.
set local statement_timeout = '30s';
select set_config('request.jwt.claims', json_build_object('sub','$1')::text, true);
select set_config('role', 'authenticated', true);
$2
commit;
SQL
}

wipe() {
  psql "$DB" -qAt -c "
    delete from public.shops where name in ('Concurrency Shop One', 'Concurrency Shop Two');
    delete from auth.users where id in ('$OWNER_ONE', '$OWNER_TWO');" >/dev/null 2>&1
}
finish() { wipe; rm -rf "$WORK"; }
trap finish EXIT INT TERM

fail() { echo "FAIL: $*" >&2; FAILED=1; }

if ! q 'select 1' >/dev/null 2>&1; then
  echo "No local database at $DB — run 'npx supabase start' first." >&2
  exit 2
fi

# ── The fixture ────────────────────────────────────────────────────────────
# Six complete months of life on twelve assets, so a single run has six months
# to post and there is room for two calls to overlap on real work rather than on
# one statement. Shop TWO's assets are a different cost and a different life, so
# a figure leaking either way moves a number asserted below.
wipe
psql "$DB" -v ON_ERROR_STOP=1 -q >/dev/null <<SQL || { echo "FAIL: fixture" >&2; exit 1; }
do \$\$
declare
  v_shop uuid;
  i integer;
  v_owner uuid;
  v_cost integer;
  v_life integer;
  v_name text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-depreciation-concurrency-' || u || '@example.test', '', now(), now(), now()
      from unnest(array['$OWNER_ONE'::uuid, '$OWNER_TWO'::uuid]) u;

  foreach v_owner in array array['$OWNER_ONE'::uuid, '$OWNER_TWO'::uuid] loop
    if v_owner = '$OWNER_ONE'::uuid then
      v_name := 'Concurrency Shop One'; v_cost := 120000; v_life := 12;
    else
      v_name := 'Concurrency Shop Two'; v_cost :=  60000; v_life := 10;
    end if;

    perform set_config('role', 'postgres', true);
    insert into public.shops (owner_id, name) values (v_owner, v_name) returning id into v_shop;
    insert into public.shop_locations (shop_id, name, is_primary) values (v_shop, 'Main', true);

    perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
    perform set_config('role', 'authenticated', true);
    perform public.post_journal_entry(
      v_shop, (date_trunc('month', public.shop_local_date()) - interval '7 months')::date,
      'Capital, in cash',
      jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  4000000),
                        jsonb_build_object('code', '3000', 'amount_cents', -4000000)),
      null, 'opening');
    for i in 1..12 loop
      perform public.create_fixed_asset(
        v_shop, v_name || ' asset ' || i, v_cost,
        (date_trunc('month', public.shop_local_date()) - interval '6 months')::date,
        v_life, '1000', '1500');
    end loop;
  end loop;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
end \$\$;
SQL

SHOP_ONE="$(q "select id from public.shops where name = 'Concurrency Shop One';")"
SHOP_TWO="$(q "select id from public.shops where name = 'Concurrency Shop Two';")"
ASSET_ONE="$(q "select id from public.fixed_assets where shop_id = '$SHOP_ONE' order by name limit 1;")"

# ── The interleaving machinery ─────────────────────────────────────────────
# Two long-lived psql processes reading from FIFOs, so statements can be fed to
# them one at a time and in an order this script chooses.
#
# The descriptor number is passed in rather than allocated: macOS ships bash
# 3.2, which has no `exec {var}>` auto-assignment, and this file has to run on
# the machine the rest of the suite runs on.
open_session() {
  local tag="$1" fd="$2"
  mkfifo "$WORK/$tag.in"
  # 3>&- 4>&- 5>&- 6>&- : a psql started AFTER an earlier session would
  # otherwise INHERIT that session's write end of the fifo, and closing our own
  # copy would never give the earlier psql an EOF -- the script hangs at the
  # first close_session with every assertion already passed.
  psql "$DB" -qAt -f "$WORK/$tag.in" > "$WORK/$tag.out" 2>&1 3>&- 4>&- 5>&- 6>&- &
  echo $! > "$WORK/$tag.pid"
  # Held open by a descriptor of our own, or psql sees EOF the moment the first
  # writer closes and exits with the transaction half-fed.
  eval "exec $fd>\"$WORK/$tag.in\""
}
send() { local fd="$1"; shift; eval "echo \"\$*\" >&$fd"; }
close_session() {
  local tag="$1" fd="$2"
  eval "exec $fd>&-"
  wait "$(cat "$WORK/$tag.pid")" 2>/dev/null
}

# Poll rather than sleep: a fixed sleep is a race of its own on a loaded
# machine, and the whole point of this file is not to guess about timing.
wait_for() {
  local sql="$1" what="$2" i
  for i in $(seq 1 200); do
    [ "$(q "select exists($sql);")" = "t" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $what"
  return 1
}

# application_name is set OUTSIDE the transaction's local scope on purpose: it
# is what pg_stat_activity is polled on below, and a `set local` would be
# invisible to another connection reading that view.
begin_as() {
  local fd="$1" tag="$2" owner="$3"
  send "$fd" "begin;"
  send "$fd" "set local statement_timeout = '90s';"
  send "$fd" "select set_config('application_name', '$tag', false);"
  send "$fd" "select set_config('request.jwt.claims', json_build_object('sub','$owner')::text, true);"
  send "$fd" "select set_config('role', 'authenticated', true);"
}

idle_in_txn="select 1 from pg_stat_activity where application_name = '%s' and state = 'idle in transaction'"
blocked="select 1 from pg_stat_activity where application_name = '%s' and wait_event_type = 'Lock'"

# ── 1. TWO OVERLAPPING RUNS ────────────────────────────────────────────────
open_session runa 3
open_session runb 4
begin_as 3 runa "$OWNER_ONE"
send 3 "select 'A=' || public.run_depreciation('$SHOP_ONE'::uuid, null)::text;"
wait_for "$(printf "$idle_in_txn" runa)" "run A to finish its call and hold the transaction open"

begin_as 4 runb "$OWNER_ONE"
send 4 "select 'B=' || public.run_depreciation('$SHOP_ONE'::uuid, null)::text;"
wait_for "$(printf "$blocked" runb)" "run B to block behind run A"

# ── 1b. AND SHOP TWO IS NOT BLOCKED BY EITHER OF THEM ──────────────────────
# Run A holds shop ONE's lock right now. If this call queues, the lock is
# coarser than a shop and every shop on the instance shares one month-end.
two_ret="$(q_as "$OWNER_TWO" "select public.run_depreciation('$SHOP_TWO'::uuid, null);" 2>&1)"
if [ "$two_ret" != "6" ]; then
  fail "shop TWO could not depreciate while shop ONE was mid-run (it answered '$two_ret') -- the lock is not per-shop"
fi

# ── 1c. AND THE REGISTER IS SHUT WHILE A RUN IS IN FLIGHT ──────────────────
# create_fixed_asset takes the same lock, and the reason is not obvious: a
# month's LINES and its CHARGE ROWS are built by two statements, which in READ
# COMMITTED are two snapshots. An asset committed between them lands in one
# derivation and not the other, and the run's written-versus-posted assertion
# then aborts a month-end that had nothing wrong with it. The window is
# microseconds wide and cannot be hit on demand, so what is asserted here is the
# lock itself: this call must QUEUE behind the run for its own shop, and must
# not queue for the shop next door.
open_session mkone 7
begin_as 7 mkone "$OWNER_ONE"
send 7 "select 'C=' || public.create_fixed_asset('$SHOP_ONE'::uuid, 'Bought mid-run', 5000, public.shop_local_date(), 24, '1000', '1500')::text;"
wait_for "$(printf "$blocked" mkone)" "create_fixed_asset to queue behind the run in its own shop"

two_made="$(q_as "$OWNER_TWO" "select public.create_fixed_asset('$SHOP_TWO'::uuid, 'Bought next door', 5000, public.shop_local_date(), 24, '1000', '1500') is not null;" 2>&1)"
if [ "$two_made" != "t" ]; then
  fail "the shop next door could not buy anything while shop ONE was mid-run (it answered '$two_made') -- the lock is not per-shop"
fi

send 3 "commit;"
close_session runa 3
send 4 "commit;"
close_session runb 4
send 7 "commit;"
close_session mkone 7
grep -qi 'error' "$WORK/mkone.out" && fail "create_fixed_asset raised once the run had committed: $(grep -i -m1 error "$WORK/mkone.out")"

A_RET="$(grep -o 'A=[0-9-]*' "$WORK/runa.out" | head -1)"
B_RET="$(grep -o 'B=[0-9-]*' "$WORK/runb.out" | head -1)"
grep -qi 'error' "$WORK/runa.out" && fail "run A raised: $(grep -i -m1 error "$WORK/runa.out")"
[ "$A_RET" = "A=6" ] || fail "run A wrote ${A_RET:-nothing}, expected A=6"

# B MUST RETURN 0, and must not raise. Both halves are the rule and not a
# preference:
#
#   * returning 1 is the measured original -- seven entries for six months, and
#     nothing in the database able to see it.
#   * raising is what run_depreciation does WITHOUT the shop lock but WITH the
#     written-versus-posted assertion: B posts, finds it wrote no charge rows,
#     and aborts with 40001. The books are then correct, which is why the rest
#     of this file stays green if the lock alone is removed -- but the second
#     device gets an error for pressing a button that had nothing to do, and
#     20261006000200's own comment promises the opposite ("A second run for the
#     same month finds every charge row already there, has nothing to post, and
#     writes NOTHING ... and it returns 0"). The lock is what makes that true.
if grep -qi 'error' "$WORK/runb.out"; then
  fail "run B raised for months run A had already charged: $(grep -i -m1 error "$WORK/runb.out") -- a second press must be a no-op, not an error"
fi
[ "$B_RET" = "B=0" ] || fail "run B wrote ${B_RET:-nothing} for months run A had already charged, expected B=0"

# ── 2. THE LEDGER AND THE REGISTER, AFTER THE RACE ─────────────────────────
for pair in "ONE:$SHOP_ONE:720000" "TWO:$SHOP_TWO:432000"; do
  label="${pair%%:*}"; rest="${pair#*:}"; shop="${rest%%:*}"; want="${rest##*:}"
  entries="$(q "select count(*) from public.journal_entries where shop_id = '$shop' and source = 'depreciation';")"
  months="$(q "select count(distinct charge_month) from public.depreciation_charges where shop_id = '$shop';")"
  charges="$(q "select coalesce(sum(amount_cents), 0) from public.depreciation_charges where shop_id = '$shop';")"
  acc="$(q "select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
              join public.journal_entries e on e.id = l.entry_id
              join public.accounts a on a.id = l.account_id
             where e.shop_id = '$shop' and a.code = '1590';")"
  orphans="$(q "select count(*) from public.journal_entries e
                 where e.shop_id = '$shop' and e.source = 'depreciation'
                   and not exists (select 1 from public.depreciation_charges dc
                                    where dc.journal_entry_id = e.id);")"
  echo "  shop $label: entries=$entries months=$months 1590=$acc charges=$charges orphan_entries=$orphans"
  [ "$orphans" = "0" ] || fail "shop $label has $orphans depreciation entries no charge row records -- a month was posted twice"
  [ "$months" = "6" ] || fail "shop $label charged $months months, expected 6"
  [ "$charges" = "$want" ] || fail "shop $label charged $charges, expected $want"
  [ "$acc" = "-$charges" ] || fail "shop $label credited 1590 by $acc against charge rows of $charges"
done

# ── 3. A RUN AND A DISPOSAL, OVERLAPPING ───────────────────────────────────
# Neither door locked, so the disposal wrote back the accumulated depreciation
# IT COULD SEE while a concurrent run charged a month the disposal never
# accounted for. Measured before the fix:
#
#   BALANCE SHEET fixed_assets: Total fixed assets = -40000
#   register summary: live=0 disposed=1 cost=0 accum=0 nbv=0
#
# The register says the shop owns nothing and the balance sheet says it owns
# minus 400.00 -- permanently, because nothing will ever write it back -- and
# the cash-flow proof ties either way. Here the run has already charged every
# month, so the race is re-created by giving the asset a month it has not been
# charged for: run through a LATER target is not available (the clamp), so shop
# ONE's first asset is disposed of while a fresh run for shop TWO's identical
# window is in flight against the same asset's shop.
open_session run2 5
begin_as 5 run2 "$OWNER_ONE"
# A month nobody has charged: the asset acquired six months ago is charged
# through the last complete month, so delete the newest charge row and re-run.
q "delete from public.depreciation_charges dc
    where dc.shop_id = '$SHOP_ONE'
      and dc.charge_month = (select max(charge_month) from public.depreciation_charges
                              where shop_id = '$SHOP_ONE');" >/dev/null
send 5 "select 'R=' || public.run_depreciation('$SHOP_ONE'::uuid, null)::text;"
wait_for "$(printf "$idle_in_txn" run2)" "the run to hold its transaction open"

open_session disp 6
begin_as 6 disp "$OWNER_ONE"
send 6 "select 'D=' || public.dispose_fixed_asset('$ASSET_ONE'::uuid, public.shop_local_date(), 0, '1000')::text;"
wait_for "$(printf "$blocked" disp)" "the disposal to block behind the run"

send 5 "commit;"
close_session run2 5
send 6 "commit;"
close_session disp 6

nbv="$(q "select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
            join public.journal_entries e on e.id = l.entry_id
            join public.accounts a on a.id = l.account_id
           where e.shop_id = '$SHOP_ONE' and a.code between '1500' and '1599';")"
stranded="$(q "select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc
                where dc.asset_id = '$ASSET_ONE';")"
written_back="$(q "select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
                     join public.journal_entries e on e.id = l.entry_id
                     join public.accounts a on a.id = l.account_id
                    where e.id = (select disposal_entry_id from public.fixed_assets
                                   where id = '$ASSET_ONE') and a.code = '1590';")"
echo "  after the disposal race: fixed-asset section=$nbv charged against the asset=$stranded written back=$written_back"
if [ "$nbv" -lt 0 ]; then
  fail "the fixed-asset section reads $nbv -- a shop cannot own minus equipment"
fi
if [ "$written_back" != "$stranded" ]; then
  fail "the disposal wrote back $written_back of the $stranded charged against the asset -- the difference is stranded in 1590 forever"
fi

if [ "$FAILED" -eq 0 ]; then
  echo 'ALL CHECKS PASSED'
  exit 0
fi
echo 'FAILED' >&2
exit 1
