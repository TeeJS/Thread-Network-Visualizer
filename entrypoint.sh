#!/bin/sh
# Seed /config/device_names.json from the baked-in default on first run,
# then symlink it into the web root so edits on the Unraid host are served
# live (refresh the browser to pick up changes).
set -eu

CONFIG_DIR="/config"
WEB_DIR="/www"
DEFAULT="${WEB_DIR}/device_names.json.default"
TARGET="${CONFIG_DIR}/device_names.json"

mkdir -p "$CONFIG_DIR"

if [ ! -f "$TARGET" ]; then
  echo "[entrypoint] Seeding default device_names.json into $CONFIG_DIR"
  cp "$DEFAULT" "$TARGET"
fi

# Always re-link so container rebuilds pick up the mounted file
ln -sf "$TARGET" "${WEB_DIR}/device_names.json"

echo "[entrypoint] Serving $WEB_DIR on :8080"
exec busybox httpd -f -v -p 8080 -c /etc/httpd.conf -h "$WEB_DIR"
