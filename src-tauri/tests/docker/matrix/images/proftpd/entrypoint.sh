#!/bin/sh
set -eu
# mod_sftp only reads authorized keys in RFC 4716 format.
if [ -s /keys/authorized_keys ]; then
  : >/etc/proftpd/authorized_keys/testuser
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    printf '%s\n' "$key" >/tmp/key.pub
    ssh-keygen -e -f /tmp/key.pub >>/etc/proftpd/authorized_keys/testuser
  done </keys/authorized_keys
  rm -f /tmp/key.pub
fi
exec proftpd --nodaemon --config "${PROFTPD_CONFIG:?}"
