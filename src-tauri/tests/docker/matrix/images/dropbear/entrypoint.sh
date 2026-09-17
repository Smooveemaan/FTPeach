#!/bin/sh
set -eu
# Dropbear only reads ~/.ssh/authorized_keys, owned by the user, not group or
# world writable.
if [ -s /keys/authorized_keys ]; then
  mkdir -p /home/testuser/.ssh
  install -o testuser -g testuser -m 600 /keys/authorized_keys /home/testuser/.ssh/authorized_keys
  chown testuser:testuser /home/testuser/.ssh
  chmod 700 /home/testuser/.ssh
fi
exec dropbear -F -E -p 22 \
  -r /etc/dropbear/dropbear_ed25519_host_key \
  -r /etc/dropbear/dropbear_ecdsa_host_key \
  -r /etc/dropbear/dropbear_rsa_host_key
