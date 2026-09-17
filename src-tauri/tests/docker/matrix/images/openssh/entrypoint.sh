#!/bin/sh
set -eu
# sshd's StrictModes rejects authorized_keys on a bind mount it does not own, so
# copy the generated keys into a root-owned file.
if [ -s /keys/authorized_keys ]; then
  install -o root -g root -m 644 /keys/authorized_keys /etc/ssh/authorized_keys/testuser
fi
# The chroot variant needs a root-owned, non-writable chroot directory.
if [ -d /srv/chroot ]; then
  chown root:root /srv/chroot
  chmod 755 /srv/chroot
  mkdir -p /srv/chroot/readonly
  printf 'root-owned, not writable by testuser\n' >/srv/chroot/readonly/readme.txt
  chown -R root:root /srv/chroot/readonly
  chmod 755 /srv/chroot/readonly
  chmod 644 /srv/chroot/readonly/readme.txt
fi
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
