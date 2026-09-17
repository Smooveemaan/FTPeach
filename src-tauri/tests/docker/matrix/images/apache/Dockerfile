# Apache httpd mod_dav for the apache_* targets; the mounted site config picks
# Basic, Digest or HTTPS. Workers run as testuser so fixture permissions
# (unreadable file/directory) apply to WebDAV requests too.
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

RUN apt-get update \
    && apt-get install -y --no-install-recommends apache2 apache2-utils openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 testuser \
    && useradd --uid 1001 --gid 1001 --home-dir /srv/dav --no-create-home --shell /usr/sbin/nologin testuser \
    && sed -i 's/^export APACHE_RUN_USER=.*/export APACHE_RUN_USER=testuser/; s/^export APACHE_RUN_GROUP=.*/export APACHE_RUN_GROUP=testuser/' /etc/apache2/envvars \
    && a2enmod dav dav_fs auth_digest ssl headers \
    && a2dissite 000-default \
    && : >/etc/apache2/ports.conf \
    && htpasswd -bc /etc/apache2/dav.htpasswd testuser testpass \
    && printf 'testuser:FTPeach matrix:%s\n' \
        "$(printf 'testuser:FTPeach matrix:testpass' | md5sum | cut -d' ' -f1)" \
        >/etc/apache2/dav.htdigest \
    && mkdir -p /var/lib/apache2/davlock \
    && chown testuser:testuser /var/lib/apache2/davlock \
    && sed -i 's#^ErrorLog .*#ErrorLog /proc/self/fd/2#' /etc/apache2/apache2.conf

EXPOSE 80 443
CMD ["apache2ctl", "-D", "FOREGROUND"]
