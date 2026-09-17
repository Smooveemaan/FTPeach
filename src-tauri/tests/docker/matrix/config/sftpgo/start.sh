#!/bin/sh
# Builds SFTPGo's initial data (the testuser account with the generated public
# keys) and starts the service. Run with `sh`, so no executable bit is needed on
# the bind mount. Everything else is configured through SFTPGO_* variables in
# docker-compose.yml.
set -eu

keys=''
if [ -s /keys/authorized_keys ]; then
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    keys="$keys${keys:+,}\"$key\""
  done </keys/authorized_keys
fi

cat >/tmp/ftpeach-users.json <<JSON
{
  "users": [
    {
      "id": 1,
      "status": 1,
      "username": "testuser",
      "password": "testpass",
      "public_keys": [$keys],
      "home_dir": "/srv/sftpgo/data/testuser",
      "permissions": { "/": ["*"] }
    }
  ],
  "version": 17
}
JSON

export SFTPGO_LOADDATA_FROM=/tmp/ftpeach-users.json
export SFTPGO_LOADDATA_MODE=0
exec sftpgo serve
