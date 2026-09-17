# Helper image for the one-shot matrix services: TLS generation, client SSH
# keys and server-side fixtures. Built locally so every tool version follows the
# pinned Debian base instead of a third-party entrypoint.
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl openssh-client python3 \
    && rm -rf /var/lib/apt/lists/*
