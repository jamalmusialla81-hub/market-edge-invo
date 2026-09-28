#!/usr/bin/env bash
# Creates ./bots the way the official hummingbot-api repo ships it, so the
# API container can log in to master_account at startup. Copies the official
# repo's bots/ tree at the tag matching the pinned image; if that clone is
# not possible, creates the minimal directories the API requires.
set -euo pipefail
cd "$(dirname "$0")"
REF="${HUMMINGBOT_API_REF:-v1.0.1}"
if [ -d bots/credentials/master_account/connectors ]; then echo "bots/ already set up"; exit 0; fi
tmp="$(mktemp -d)"
if git clone -q --depth 1 --branch "$REF" https://github.com/hummingbot/hummingbot-api "$tmp/hb" 2>/dev/null \
   || git clone -q --depth 1 https://github.com/hummingbot/hummingbot-api "$tmp/hb"; then
  cp -r "$tmp/hb/bots" ./bots
  echo "bots/ copied from hummingbot-api $(git -C "$tmp/hb" describe --tags --always)"
fi
mkdir -p bots/credentials/master_account/connectors bots/instances bots/conf bots/archived
rm -rf "$tmp"
