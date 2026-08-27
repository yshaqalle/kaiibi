#!/usr/bin/env bash
#
# Every database check, in one command, failing loudly.
#
# This exists because verify-loyalty check 11 was red for four migrations and
# nobody noticed. The test was right, it was written for exactly the bug that had
# happened, and it sat there failing against a database nobody was resetting --
# because running the suite meant remembering eleven psql invocations from a
# README and reading eleven walls of NOTICE output for the word FAIL.
#
# A suite you have to assemble by hand is a suite that silently stops running.
#
# Usage:
#   npm run test:db              # applies every migration first, then checks
#   npm run test:db -- --no-reset  # skip the reset when iterating on one script
#
# Requires a local stack: `npx supabase start`.

set -uo pipefail

DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESET=1

for arg in "$@"; do
  case "$arg" in
    --no-reset) RESET=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if ! psql "$DB_URL" -qAt -c 'select 1' >/dev/null 2>&1; then
  echo "No local database at $DB_URL — run 'npx supabase start' first." >&2
  exit 2
fi

if [ "$RESET" -eq 1 ]; then
  # Worth doing every time, not just for a clean slate: it proves the whole
  # migration chain still applies from nothing, which pushing incrementally to a
  # long-lived project never checks.
  echo "▸ Rebuilding from every migration…"
  if ! npx supabase db reset --local >/dev/null 2>&1; then
    echo "  FAILED — the migration chain does not apply to an empty database." >&2
    echo "  Re-run 'npx supabase db reset --local' to see why." >&2
    exit 1
  fi
fi

failed=()
skipped=()
passed=0

# Two kinds of script live here, and treating them as one kind is how this runner
# first reported a PASSING script as FAIL -- which is worse than missing a
# failure, because a runner that cries wolf is a runner people stop reading.
#
#   * self-contained checks: build their own fixture, assert, roll back. These
#     must pass, and they are what this command is for.
#   * scripts that read an existing shop, or print figures instead of asserting.
#     They are skipped here and named at the end, never counted as passing.
#
# Declared by a marker on the script's first lines rather than by a list in here,
# so the fact lives with the file and cannot drift away from it.
for script in "$HERE"/verify-*.sql "$HERE"/bench-*.sql; do
  name="$(basename "$script" .sql)"

  if grep -qm1 '@requires-populated-database' "$script"; then
    printf '  %-32s %s\n' "$name" 'skipped — needs an existing shop'
    skipped+=("$name")
    continue
  fi
  if grep -qm1 '@no-verdict' "$script"; then
    printf '  %-32s %s\n' "$name" 'skipped — prints figures, asserts nothing'
    skipped+=("$name")
    continue
  fi

  printf '  %-32s ' "$name"
  output="$(psql "$DB_URL" -f "$script" 2>&1)"
  # Both phrasings in use. Matching only the first one is what made
  # verify-platform-shop-people read as a failure for its whole life.
  if grep -qiE 'ALL CHECKS PASSED|all assertions passed' <<<"$output"; then
    echo 'pass'
    passed=$((passed + 1))
  else
    echo 'FAIL'
    failed+=("$name")
    # The first error only. These scripts stop at the first failure anyway, and
    # printing the whole NOTICE log is what made failures easy to skim past.
    grep -m1 -E 'ERROR|FAIL:' <<<"$output" | sed 's/^/      /'
  fi
done

# A THIRD kind, added for phase 3c: a check that needs TWO DATABASE SESSIONS and
# therefore cannot be a .sql file, because psql gives one. There is exactly one
# today -- verify-depreciation-concurrency.sh, for a duplicate depreciation entry
# that no serial test can reach and that every totals check, the trial balance
# and the cash-flow proof were all blind to. It builds and deletes its own
# COMMITTED fixture, which is why it is not a .sql script that rolls back.
#
# Same contract as the rest: print ALL CHECKS PASSED or be a failure. Run last,
# because it is the slowest and because a failure here is easier to read after
# the cheap checks have already said whether the schema is sound.
for script in "$HERE"/verify-*.sh; do
  name="$(basename "$script" .sh)"
  printf '  %-32s ' "$name"
  output="$(bash "$script" 2>&1)"
  if grep -qiE 'ALL CHECKS PASSED|all assertions passed' <<<"$output"; then
    echo 'pass'
    passed=$((passed + 1))
  else
    echo 'FAIL'
    failed+=("$name")
    grep -m3 -E 'ERROR|FAIL' <<<"$output" | sed 's/^/      /'
  fi
done

echo
if [ ${#skipped[@]} -gt 0 ]; then
  echo "${#skipped[@]} not exercised: ${skipped[*]}"
  echo "  Run those against a database that already has a shop and a sale."
fi

if [ ${#failed[@]} -eq 0 ]; then
  echo "$passed database checks passed."
  exit 0
fi

echo "$passed passed, ${#failed[@]} FAILED: ${failed[*]}" >&2
echo "Re-run one with: psql \"\$SUPABASE_DB_URL\" -f supabase/tests/<name>.sql" >&2
exit 1
