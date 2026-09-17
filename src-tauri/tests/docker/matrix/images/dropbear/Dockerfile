# Dropbear, the SSH server on most embedded Linux devices (OpenWrt, many NAS
# and router firmwares). It has no SFTP of its own and execs OpenSSH's
# sftp-server binary, exactly as on those devices.
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

RUN apt-get update \
    && apt-get install -y --no-install-recommends dropbear-bin openssh-sftp-server \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 testuser \
    && useradd --uid 1001 --gid 1001 --home-dir /home/testuser --no-create-home --shell /bin/bash testuser \
    && echo 'testuser:testpass' | chpasswd \
    && mkdir -p /etc/dropbear \
    && dropbearkey -t ed25519 -f /etc/dropbear/dropbear_ed25519_host_key \
    && dropbearkey -t ecdsa -s 256 -f /etc/dropbear/dropbear_ecdsa_host_key \
    && dropbearkey -t rsa -s 3072 -f /etc/dropbear/dropbear_rsa_host_key

COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
