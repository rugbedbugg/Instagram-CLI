#!/usr/bin/env bash
# Regenerates the synthetic certificates for the offline TLS tests. They name
# only loopback or reserved hosts and are trusted by nothing but these tests.
set -euo pipefail
cd "$(dirname "$0")"
days=36500

openssl req -x509 -newkey rsa:2048 -nodes -days "$days" -subj '/CN=Instagram-CLI Test Root CA' \
	-addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
	-keyout ca.key -out ca.crt

leaf() {
	local name=$1 subject=$2 san=$3
	openssl req -newkey rsa:2048 -nodes -subj "/CN=$subject" -keyout "$name.key" -out "$name.csr"
	openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days "$days" \
		-extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san") -out "$name.crt"
	rm "$name.csr"
}

leaf localhost localhost 'DNS:localhost,IP:127.0.0.1'
leaf wrong-host wrong-host.invalid 'DNS:wrong-host.invalid'

openssl req -x509 -newkey rsa:2048 -nodes -days "$days" -subj '/CN=localhost' \
	-addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout self-signed.key -out self-signed.crt

rm -f ca.srl ca.key
