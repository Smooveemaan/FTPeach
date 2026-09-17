#!/bin/sh
# Runs once, right after the image's automatic installation: creates testuser,
# copies the seeded fixtures into its files and indexes them. The healthcheck
# waits for the ready marker written at the end.
set -eu
occ() {
  php /var/www/html/occ "$@"
}

# Test-only settings: no password policy (testpass is too short for it), no
# login throttling (wrong-password tests would slow every later login), no
# skeleton files in the new account.
occ app:disable password_policy || true
occ config:system:set auth.bruteforce.protection.enabled --value=false --type=boolean
occ config:system:set skeletondirectory --value=''

OC_PASS=testpass occ user:add --password-from-env --display-name 'FTPeach test user' testuser

files=/var/www/html/data/testuser/files
mkdir -p "$files"
cp -a /ftpeach-seed/fixtures "$files/"
occ files:scan testuser

touch /var/www/html/data/.ftpeach-ready
