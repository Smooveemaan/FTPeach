# One OpenSSH image for every openssh_* target; the mounted sshd_config decides
# the variant. Host keys are generated at build time so they stay stable across
# container restarts (recreating the image is how a host-key change is tested).
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 testuser \
    && useradd --uid 1001 --gid 1001 --home-dir /home/testuser --no-create-home --shell /bin/bash testuser \
    && echo 'testuser:testpass' | chpasswd \
    && rm -f /etc/ssh/ssh_host_* \
    && ssh-keygen -A \
    && mkdir -p /run/sshd /etc/ssh/authorized_keys \
    && printf '%s\n' \
        'FTPeach matrix OpenSSH (chroot variant).' \
        'Authorized test use only. This banner must not break the login.' \
        >/etc/ssh/banner.txt

COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
