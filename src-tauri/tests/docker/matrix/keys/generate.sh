#!/bin/sh
# Generates the client key pairs the SFTP tests log in with. Private keys stay
# in the git-ignored generated/ directory; servers only receive
# authorized_keys (every public key concatenated).
#   id_ed25519, id_rsa (3072), id_ecdsa (P-256): no passphrase
#   id_ed25519_passphrase: passphrase "keypass"
set -eu

out=/generated/keys
mkdir -p "$out"
cd "$out"

make_key() {
  file=$1
  passphrase=$2
  shift 2
  [ -s "$file" ] && [ -s "$file.pub" ] && return 0
  rm -f "$file" "$file.pub"
  ssh-keygen -q -C "ftpeach-matrix-$file" -N "$passphrase" -f "$file" "$@"
}

make_key id_ed25519 '' -t ed25519
make_key id_rsa '' -t rsa -b 3072
make_key id_ecdsa '' -t ecdsa -b 256
make_key id_ed25519_passphrase keypass -t ed25519

cat id_ed25519.pub id_rsa.pub id_ecdsa.pub id_ed25519_passphrase.pub >authorized_keys
chmod 644 ./*
echo "Client keys ready"
