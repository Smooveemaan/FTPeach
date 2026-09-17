# Official Nextcloud image plus hooks: post-installation creates testuser,
# before-starting imports the seeded fixtures when they changed. The hooks are
# copied in (not bind-mounted) because the entrypoint skips hooks without the
# executable bit.
FROM nextcloud:34.0.4-apache@sha256:fca405153f43542409c7351636752e388329c07418557f04e6fcbdeeaf64585d

COPY --chmod=755 post-installation.sh /docker-entrypoint-hooks.d/post-installation/50-ftpeach.sh
COPY --chmod=755 before-starting.sh /docker-entrypoint-hooks.d/before-starting/50-ftpeach.sh
