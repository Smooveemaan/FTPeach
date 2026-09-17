# Squid as an HTTP CONNECT proxy: port 3128 without authentication, 3129 with
# Basic authentication (proxyuser / proxypass).
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

RUN apt-get update \
    && apt-get install -y --no-install-recommends squid openssl \
    && rm -rf /var/lib/apt/lists/* \
    && printf 'proxyuser:%s\n' "$(openssl passwd -apr1 proxypass)" >/etc/squid/passwd \
    && chown proxy:proxy /etc/squid/passwd

COPY squid.conf /etc/squid/squid.conf

EXPOSE 3128 3129
ENTRYPOINT ["squid", "-N", "-d", "1", "-f", "/etc/squid/squid.conf"]
