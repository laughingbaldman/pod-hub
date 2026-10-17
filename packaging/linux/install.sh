#!/bin/sh
# Install or upgrade the Hub server from an unpacked release folder (run as root from inside it).
# Each version lives in /opt/part-hub/releases/<version>; /opt/part-hub/current points at the live one.
# Roll back with: sudo /opt/part-hub/releases/<older>/packaging/linux/install.sh --activate
set -eu
HERE=$(cd "$(dirname "$0")/../.." && pwd)
VERSION=$(cat "$HERE/VERSION")
DEST=/opt/part-hub/releases/$VERSION

id parthub >/dev/null 2>&1 || useradd --system --home /var/lib/part-hub --shell /usr/sbin/nologin parthub
install -d -o parthub -g parthub -m 0750 /var/lib/part-hub

if [ "${1:-}" != "--activate" ]; then
  # Back up before touching anything (no-op if no backupDir is configured).
  if [ -L /opt/part-hub/current ]; then
    sudo -u parthub HUB_DATA_DIR=/var/lib/part-hub /opt/part-hub/current/node/node /opt/part-hub/current/server/dist/cli.js backup || true
  fi
  mkdir -p /opt/part-hub/releases
  rm -rf "$DEST"
  cp -a "$HERE" "$DEST"
fi

ln -sfn "$DEST" /opt/part-hub/current
install -m 0644 "$DEST/packaging/linux/part-hub.service" /etc/systemd/system/part-hub.service
systemctl daemon-reload
systemctl enable part-hub.service
systemctl restart part-hub.service
echo "Hub server $VERSION is running. First time? Create the owner account:"
echo "  sudo -u parthub HUB_DATA_DIR=/var/lib/part-hub /opt/part-hub/current/node/node /opt/part-hub/current/server/dist/cli.js create-admin owner"
