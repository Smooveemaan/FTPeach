# Official Nextcloud image plus a post-installation hook that creates testuser
# and imports the seeded fixtures. The hook is copied in (not bind-mounted)
# because the entrypoint skips hooks without the executable bit.
FROM nextcloud:34.0.4-apache@sha256:fca405153f43542409c7351636752e388329c07418557f04e6fcbdeeaf64585d

COPY --chmod=755 post-installation.sh /docker-entrypoint-hooks.d/post-installation/50-ftpeach.sh
