#!/usr/bin/env bash
# Helper for running kaiibi on Android emulators (phone + tablets).
#
#   ./scripts/android-emu.sh start [phone|11|14|all]   boot emulator(s)
#   ./scripts/android-emu.sh install [phone|11|14|all] install the debug APK
#   ./scripts/android-emu.sh launch  [phone|11|14|all] open the app
#   ./scripts/android-emu.sh kb on|off [phone|11|14|all]
#   ./scripts/android-emu.sh list                      show attached devices
#
# `kb on`  shows the on-screen keyboard even though a hardware keyboard is
# attached; `kb off` hides it again and you type with the Mac keyboard.

set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"

PKG="com.kaiibisteam.kaiibi"
APK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/android/app/build/outputs/apk/debug/app-debug.apk"

avd_for() {
  case "$1" in
    phone) echo "Pixel_8_API_35" ;;
    11)    echo "Tablet_11_API_35" ;;
    14)    echo "Tablet_14_API_35" ;;
    *)     echo "unknown target: $1" >&2; exit 1 ;;
  esac
}

# Emulators claim consecutive ports from 5554 in launch order, so resolve the
# serial by asking each running device which AVD it is.
serial_for() {
  local avd want
  want="$(avd_for "$1")"
  for s in $("$ADB" devices | awk '/emulator-/ {print $1}'); do
    avd="$("$ADB" -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\r')"
    [ "$avd" = "$want" ] && { echo "$s"; return 0; }
  done
  return 1
}

targets() { [ "${1:-all}" = "all" ] && echo "phone 11 14" || echo "$1"; }

cmd_start() {
  for t in $(targets "${1:-all}"); do
    local avd; avd="$(avd_for "$t")"
    if serial_for "$t" >/dev/null 2>&1; then echo "$avd already running"; continue; fi
    # A hard-killed emulator leaves lock dirs behind that block the next boot.
    rm -rf "$HOME/.android/avd/$avd.avd/multiinstance.lock" \
           "$HOME/.android/avd/$avd.avd/hardware-qemu.ini.lock"
    echo "booting $avd..."
    nohup "$EMULATOR" -avd "$avd" >/dev/null 2>&1 & disown
    sleep 5
  done
  "$ADB" wait-for-device
}

cmd_install() {
  [ -f "$APK" ] || { echo "no debug APK; run: npx expo run:android" >&2; exit 1; }
  for t in $(targets "${1:-all}"); do
    local s; s="$(serial_for "$t")" || { echo "$t not running"; continue; }
    echo "installing to $t ($s)"
    "$ADB" -s "$s" install -r "$APK" >/dev/null
    "$ADB" -s "$s" reverse tcp:8081 tcp:8081 >/dev/null
  done
}

cmd_launch() {
  for t in $(targets "${1:-all}"); do
    local s; s="$(serial_for "$t")" || { echo "$t not running"; continue; }
    "$ADB" -s "$s" reverse tcp:8081 tcp:8081 >/dev/null 2>&1 || true
    "$ADB" -s "$s" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
    echo "$t launched"
  done
}

cmd_kb() {
  local mode="$1"; shift
  local val
  case "$mode" in
    on)  val=1 ;;
    off) val=0 ;;
    *)   echo "usage: kb on|off [target]" >&2; exit 1 ;;
  esac
  for t in $(targets "${1:-all}"); do
    local s; s="$(serial_for "$t")" || { echo "$t not running"; continue; }
    "$ADB" -s "$s" shell settings put secure show_ime_with_hard_keyboard $val
    echo "$t on-screen keyboard: $mode"
  done
}

cmd_list() {
  for s in $("$ADB" devices | awk '/emulator-/ {print $1}'); do
    printf "%-16s %-20s %s\n" "$s" \
      "$("$ADB" -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\r')" \
      "$("$ADB" -s "$s" shell wm size 2>/dev/null | tr -d '\r')"
  done
}

case "${1:-}" in
  start)   shift; cmd_start "${1:-all}" ;;
  install) shift; cmd_install "${1:-all}" ;;
  launch)  shift; cmd_launch "${1:-all}" ;;
  kb)      shift; cmd_kb "$@" ;;
  list)    cmd_list ;;
  *) grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -12 ;;
esac
