#!/bin/sh
# Runs on every start: copies the seeded fixtures into testuser's files and
# indexes them whenever the seed differs from the one imported last (a new
# seed version or big-file size), since the installation keeps its volume.
# The healthcheck waits for the ready marker written at the end.
set -eu
occ() {
  php /var/www/html/occ "$@"
}

data=/var/www/html/data
if cmp -s /ftpeach-seed/.ftpeach-seed "$data/.ftpeach-seed"; then
  touch "$data/.ftpeach-ready"
  exit 0
fi
rm -f "$data/.ftpeach-ready"

files="$data/testuser/files"
mkdir -p "$files"
rm -rf "$files/fixtures"
cp -a /ftpeach-seed/fixtures "$files/"
occ files:scan testuser

cp /ftpeach-seed/.ftpeach-seed "$data/.ftpeach-seed"
touch "$data/.ftpeach-ready"
