# nginx with the core dav module plus dav_ext (PROPFIND/OPTIONS/LOCK) for the
# nginx_* and webdav_subpath targets; the mounted server config picks the
# variant. Workers run as testuser so fixture permissions apply.
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx libnginx-mod-http-dav-ext openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 testuser \
    && useradd --uid 1001 --gid 1001 --home-dir /srv/dav --no-create-home --shell /usr/sbin/nologin testuser \
    && sed -i 's/^user .*;/user testuser;/' /etc/nginx/nginx.conf \
    && rm -f /etc/nginx/sites-enabled/default \
    && printf 'testuser:%s\n' "$(openssl passwd -apr1 testpass)" >/etc/nginx/dav.htpasswd \
    && ln -sf /dev/stdout /var/log/nginx/access.log \
    && ln -sf /dev/stderr /var/log/nginx/error.log

EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
