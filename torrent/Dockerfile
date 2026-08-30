FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends qbittorrent-nox curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY qBittorrent.conf /defaults/qBittorrent.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh
EXPOSE 8080 6881/tcp 6881/udp
ENTRYPOINT ["/entrypoint.sh"]
