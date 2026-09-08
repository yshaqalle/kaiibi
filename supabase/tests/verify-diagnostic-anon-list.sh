#!/usr/bin/env bash
#
# The anon surface is written down twice. This is what stops the two copies
# from disagreeing.
#
# WHY TWICE AT ALL. verify-anon-rpc-surface.sql is the enforced pin: CI runs it
# against a database built from every migration, and it goes red the moment a
# function becomes anon-callable without being listed. scripts/diagnose-
# production.sql needs the same list to say anything useful about a PRODUCTION
# database -- and it has to do that standalone, pointed at a URL, with no repo
# checkout and no test suite around it. It cannot import the pin. So it carries
# a copy.
#
# WHY THAT COPY WENT WRONG TWICE BEFORE THIS FILE EXISTED. It was not a copy of
# the list; it was PROSE ABOUT the list, in \echo banners. It said "EXPECT
# EXACTLY FOUR" for the entire life of a six-function surface, and later
# described a two-write surface as having exactly one write. Nothing in this
# repo could have caught either, because nothing reads an \echo line. Both were
# found by a human reading the file, which is the slowest detector available
# and precisely what diagnose-production.sql exists to replace.
#
# The names are data in both files now, between markers, and this check reads
# them out of both and compares. Duplication is fine when it cannot drift.
#
# WHAT A FAILURE MEANS. Somebody changed one list and not the other. Neither
# copy is automatically the right one -- decide which, then make them match.
# If a function is genuinely joining or leaving the anon surface, the pin file
# is where the reasoning goes; this script only enforces that the diagnostic
# agrees with whatever the pin file decided.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN="$HERE/verify-anon-rpc-surface.sql"
DIAG="$HERE/../../scripts/diagnose-production.sql"

fail() { echo "FAIL: $*" >&2; exit 1; }

for f in "$PIN" "$DIAG"; do
  [ -f "$f" ] || fail "missing $f"
done

# Both extractions are anchored on markers rather than line numbers, so that
# reflowing a comment above either list cannot silently empty this check.
pin_list="$(
  awk '/v_expected text\[\] := array\[/{on=1; next} on && /^[[:space:]]*\];/{exit} on' "$PIN" \
    | grep -oE "'[a-z0-9_]+'" | tr -d "'" | sort -u
)"

diag_list="$(
  awk '/>>> PINNED ANON SURFACE >>>/{on=1; next} on && /<<< PINNED ANON SURFACE <<</{exit} on' "$DIAG" \
    | grep -oE "'[a-z0-9_]+'" | tr -d "'" | sort -u
)"

# The character class includes DIGITS. It did not at first, which meant a name
# like get_public_order_v2 was invisible to this script: add it to one file and
# not the other and this check passed, silently, on the exact disagreement it
# exists to catch. A guard against silent success is not allowed to have one.
#
# An empty list is a broken extraction, not a passing check. Without this, a
# renamed marker would make both sides empty and this script would cheerfully
# report agreement -- the same failure wearing a different hat.
[ -n "$pin_list" ]  || fail "extracted no names from $(basename "$PIN") -- has the array or its marker changed?"
[ -n "$diag_list" ] || fail "extracted no names from $(basename "$DIAG") -- has the array or its marker changed?"

if [ "$pin_list" != "$diag_list" ]; then
  echo "FAIL: the two pinned anon lists disagree." >&2
  echo "  only in verify-anon-rpc-surface.sql:" >&2
  comm -23 <(echo "$pin_list") <(echo "$diag_list") | sed 's/^/    /' >&2
  echo "  only in scripts/diagnose-production.sql:" >&2
  comm -13 <(echo "$pin_list") <(echo "$diag_list") | sed 's/^/    /' >&2
  exit 1
fi

echo "ALL CHECKS PASSED: both anon lists name the same $(echo "$pin_list" | wc -l | tr -d ' ') functions"
