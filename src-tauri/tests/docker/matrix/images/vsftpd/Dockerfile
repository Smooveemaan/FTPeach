FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

RUN apt-get update \
    && apt-get install -y --no-install-recommends vsftpd \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 testuser \
    && useradd --uid 1001 --gid 1001 --home-dir /home/testuser --no-create-home --shell /bin/bash testuser \
    && echo 'testuser:testpass' | chpasswd \
    && mkdir -p /var/run/vsftpd/empty

COPY base.conf /etc/vsftpd/base.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 21 990
ENTRYPOINT ["/entrypoint.sh"]
