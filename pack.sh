#!/bin/sh
# Builds the release zip in dist/, ready for `gnome-extensions install`.
set -e

UUID=spring@webhookstudios.github.io
ROOT="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$ROOT/dist"
gnome-extensions pack --force --out-dir "$ROOT/dist" \
    --extra-source=monitor.js --extra-source=rows.js --extra-source=util.js \
    --extra-source=sampler.js --extra-source=icons --extra-source=sedge \
    "$ROOT/$UUID"

echo "Built $ROOT/dist/$UUID.shell-extension.zip"
