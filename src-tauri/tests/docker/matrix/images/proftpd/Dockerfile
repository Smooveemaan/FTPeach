# One ProFTPD image for every ProFTPD target. The mounted config decides the
# role: /etc/proftpd/matrix-ftp.conf (FTP/FTPS, with a variant include) or
# /etc/proftpd/matrix-sftp.conf (mod_sftp).
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

RUN apt-get update \
    && apt-get install -y --no-install-recommends proftpd-core proftpd-mod-crypto openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 testuser \
    && useradd --uid 1001 --gid 1001 --home-dir /home/testuser --no-create-home --shell /bin/bash testuser \
    && echo 'testuser:testpass' | chpasswd \
    && useradd --uid 1002 --gid 1001 --home-dir /home/testuser --no-create-home --shell /bin/bash readonly \
    && echo 'readonly:testpass' | chpasswd \
    && mkdir -p /run/proftpd /etc/proftpd/hostkeys /etc/proftpd/authorized_keys \
    && ssh-keygen -q -t rsa -b 3072 -m PEM -N '' -f /etc/proftpd/hostkeys/rsa \
    && ssh-keygen -q -t ecdsa -b 256 -m PEM -N '' -f /etc/proftpd/hostkeys/ecdsa \
    && ssh-keygen -q -t ed25519 -N '' -f /etc/proftpd/hostkeys/ed25519 \
    && chmod 600 /etc/proftpd/hostkeys/*

COPY common.conf /etc/proftpd/matrix-common.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
