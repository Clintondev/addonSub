#!/bin/sh
set -eu
profile=/config/qBittorrent/config
mkdir -p "$profile" /downloads/incomplete
if [ ! -f "$profile/qBittorrent.conf" ]; then
  cp /defaults/qBittorrent.conf "$profile/qBittorrent.conf"
fi
exec qbittorrent-nox --profile=/config --webui-port=8080
