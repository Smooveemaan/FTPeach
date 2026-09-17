#!/bin/sh
# Runs once, right after the image's automatic installation: creates testuser.
# The fixtures are imported by the before-starting hook, on every start the
# seed has changed since.
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
