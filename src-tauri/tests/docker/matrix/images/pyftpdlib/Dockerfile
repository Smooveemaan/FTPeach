FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

# locales: the non-UTF-8 variant runs under ru_RU.CP1251 so Python's file-system
# encoding (and therefore pyftpdlib's) is cp1251.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pyftpdlib python3-openssl locales \
    && rm -rf /var/lib/apt/lists/* \
    && localedef -i ru_RU -f CP1251 ru_RU.CP1251 \
    && groupadd --gid 1001 testuser \
    && useradd --uid 1001 --gid 1001 --home-dir /home/testuser --no-create-home --shell /bin/bash testuser

COPY server.py /server.py

USER testuser
EXPOSE 2121
ENTRYPOINT ["python3", "/server.py"]
