#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec node scripts/check-dictionary-inventory.mjs --update
