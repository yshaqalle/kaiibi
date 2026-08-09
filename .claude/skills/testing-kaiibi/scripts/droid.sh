#!/usr/bin/env bash
# Drive kaiibi on an Android emulator: read the screen, tap by label, type, screenshot.
#
#   droid.sh [-t phone|11|14] ui                    dump every labelled node as "x,y  class  'label'"
#   droid.sh [-t phone|11|14] find "Inventory"      the same, filtered (case-insensitive substring)
#   droid.sh [-t phone|11|14] tap "Inventory"       tap the centre of the first clickable match
#   droid.sh [-t phone|11|14] tapxy 540 2231        tap raw coordinates
#   droid.sh [-t phone|11|14] type "QA widget"      type into the focused field
#   droid.sh [-t phone|11|14] back                  hardware back
#   droid.sh [-t phone|11|14] goto pos              deep link to a route (kaiibi://pos)
#   droid.sh [-t phone|11|14] shot out.png          screenshot to a file
#
# -t defaults to phone. Targets match scripts/android-emu.sh: phone, 11, 14.
#
# `tap` re-dumps the tree itself, so the coordinates it uses are always current.
# Never cache coordinates across steps — a list that is still settling moves
# under you and the tap lands on whatever slid into that spot.

set -euo pipefail

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
PKG="com.kaiibisteam.kaiibi"
SCHEME="kaiibi"

TARGET=phone
while getopts "t:" opt; do
  case "$opt" in
    t) TARGET="$OPTARG" ;;
    *) exit 1 ;;
  esac
done
shift $((OPTIND - 1))

avd_for() {
  case "$1" in
    phone) echo "Pixel_8_API_35" ;;
    11)    echo "Tablet_11_API_35" ;;
    14)    echo "Tablet_14_API_35" ;;
    *)     echo "unknown target: $1" >&2; exit 1 ;;
  esac
}

# Emulators claim ports in boot order, so ask each one which AVD it is.
serial_for() {
  local want; want="$(avd_for "$1")"
  for s in $("$ADB" devices | awk '/emulator-/ {print $1}'); do
    [ "$("$ADB" -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\r')" = "$want" ] && { echo "$s"; return 0; }
  done
  echo "no running emulator for '$1' — ./scripts/android-emu.sh start $1" >&2
  return 1
}

SERIAL="$(serial_for "$TARGET")"

dump() {
  "$ADB" -s "$SERIAL" shell uiautomator dump /sdcard/kaiibi-ui.xml >/dev/null 2>&1
  "$ADB" -s "$SERIAL" shell cat /sdcard/kaiibi-ui.xml 2>/dev/null
}

# Emits: x,y<TAB>clickable<TAB>Class<TAB>'label'
parse() {
  python3 -c '
import re, sys, xml.etree.ElementTree as ET
try:
    root = ET.fromstring(sys.stdin.read())
except ET.ParseError:
    sys.exit("could not parse the UI dump - is the app foregrounded?")
needle = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
for n in root.iter("node"):
    label = n.get("text") or n.get("content-desc") or ""
    if not label or needle not in label.lower():
        continue
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", n.get("bounds")))
    cls = n.get("class", "").split(".")[-1]
    print("%d,%d\t%s\t%s\t%r" % ((x1 + x2) // 2, (y1 + y2) // 2, n.get("clickable"), cls, label))
' "$@"
}

case "${1:-}" in
  ui)    dump | parse ;;
  find)  dump | parse "${2:?need a label}" ;;

  tap)
    label="${2:?need a label}"
    tree="$(dump)"
    # Prefer a clickable node: RN renders the pressable wrapper and its Text as
    # separate nodes, and only the wrapper carries clickable="true".
    hit="$(printf '%s' "$tree" | parse "$label" | awk -F'\t' '$2=="true" {print $1; exit}')"
    [ -n "$hit" ] || hit="$(printf '%s' "$tree" | parse "$label" | awk -F'\t' 'NR==1 {print $1}')"
    [ -n "$hit" ] || { echo "no node matching '$label'" >&2; exit 1; }
    "$ADB" -s "$SERIAL" shell input tap "${hit%,*}" "${hit#*,}"
    echo "tapped '$label' at $hit"
    ;;

  tapxy) "$ADB" -s "$SERIAL" shell input tap "${2:?x}" "${3:?y}" ;;

  type)
    # `input text` reads a space as an argument separator; %s is its escape.
    "$ADB" -s "$SERIAL" shell input text "$(printf '%s' "${2:?need text}" | sed 's/ /%s/g')"
    ;;

  back)  "$ADB" -s "$SERIAL" shell input keyevent KEYCODE_BACK ;;

  goto)
    "$ADB" -s "$SERIAL" shell am start -a android.intent.action.VIEW \
      -d "$SCHEME://${2:?need a route}" "$PKG" >/dev/null
    echo "opened $SCHEME://$2"
    ;;

  shot)  "$ADB" -s "$SERIAL" exec-out screencap -p > "${2:?need a path}"; echo "wrote $2" ;;

  *) grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -16 ;;
esac
