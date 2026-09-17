# Dante SOCKS server. The mounted danted.conf picks the variant: open
# (SOCKS4/4a/5 without authentication) or auth (SOCKS5 username/password).
# Debian dropped dante-server after bookworm and upstream (inet.no) downloads
# are too unreliable for CI, so this one image stays on bookworm.
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

RUN apt-get update \
    && apt-get install -y --no-install-recommends dante-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --no-create-home --shell /usr/sbin/nologin proxyuser \
    && echo 'proxyuser:proxypass' | chpasswd

EXPOSE 1080
ENTRYPOINT ["danted", "-f", "/etc/danted.conf"]
