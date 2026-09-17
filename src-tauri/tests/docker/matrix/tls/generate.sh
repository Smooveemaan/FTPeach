#!/bin/sh
# Generates the disposable TLS material the matrix servers present:
#   ca.pem / ca.key            test CA (the client trusts it via a custom CA)
#   localhost.pem / .key       valid for localhost + 127.0.0.1, signed by the CA
#   expired.pem / .key         signed by the CA, validity window long in the past
#   wrong-cn.pem / .key        signed by the CA, issued for another host name
#   self-signed.pem / .key     valid for localhost but not signed by any CA
# Certificates live a few days only; the set is regenerated when the valid
# certificate is about to expire or anything is missing.
set -eu

out=/generated/tls
mkdir -p "$out"
cd "$out"

complete=yes
for name in ca localhost expired wrong-cn self-signed; do
  [ -s "$name.pem" ] && [ -s "$name.key" ] || complete=no
done
if [ "$complete" = yes ] && openssl x509 -checkend 86400 -noout -in localhost.pem >/dev/null; then
  echo "TLS material is current"
  exit 0
fi

rm -f ./*.pem ./*.key ./*.csr ./*.srl ./*.ext

openssl req -x509 -newkey rsa:2048 -nodes -days 7 -sha256 \
  -subj '/CN=FTPeach matrix test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout ca.key -out ca.pem

leaf() {
  name=$1
  cn=$2
  san=$3
  shift 3
  openssl req -newkey rsa:2048 -nodes -sha256 -subj "/CN=$cn" \
    -keyout "$name.key" -out "$name.csr"
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san" >"$name.ext"
  openssl x509 -req -sha256 -in "$name.csr" -CA ca.pem -CAkey ca.key -CAcreateserial \
    -extfile "$name.ext" -out "$name.pem" "$@"
}

leaf localhost localhost 'DNS:localhost,IP:127.0.0.1' -days 7
leaf expired localhost 'DNS:localhost,IP:127.0.0.1' \
  -not_before 20200101000000Z -not_after 20200201000000Z
leaf wrong-cn ftpeach.invalid 'DNS:ftpeach.invalid' -days 7

openssl req -x509 -newkey rsa:2048 -nodes -days 7 -sha256 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout self-signed.key -out self-signed.pem

rm -f ./*.csr ./*.srl ./*.ext
# Servers read these as unprivileged users (www-data, testuser, proftpd).
chmod 644 ./*.pem ./*.key
echo "TLS material generated"
