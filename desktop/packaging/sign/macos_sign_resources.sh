#!/usr/bin/env bash
# Developer ID signing of every Mach-O file in the staged resources (frozen
# Python service, its extension modules and dylibs, the Node runtime) with the
# hardened runtime, BEFORE `tauri build` copies them into the .app. Tauri then
# signs the app binary and bundle, notarizes (APPLE_ID / APPLE_PASSWORD /
# APPLE_TEAM_ID) and staples. Notarization rejects any unsigned Mach-O inside
# the bundle, which is why this step exists.
#
# usage: macos_sign_resources.sh <staged bundle dir>   (needs APPLE_SIGNING_IDENTITY)
set -euo pipefail
DIR=$1
: "${APPLE_SIGNING_IDENTITY:?no signing identity}"
ENT="$(cd "$(dirname "$0")/../../src-tauri" && pwd)/entitlements.plist"
count=0
# deepest files first so nested code is signed before what loads it
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then
    codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$APPLE_SIGNING_IDENTITY" "$f"
    count=$((count + 1))
  fi
done < <(find "$DIR" -type f -print0 | sort -rz)
echo "signed $count Mach-O files in $DIR with hardened runtime"
