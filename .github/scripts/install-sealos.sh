#!/usr/bin/env bash
set -euo pipefail

SEALOS_VERSION="${SEALOS_VERSION:-v5.1.2-rc5}"

if command -v sealos >/dev/null 2>&1; then
  sealos version
  exit 0
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

arch="$(uname -m)"
case "${arch}" in
  x86_64|amd64)
    sealos_arch="amd64"
    ;;
  aarch64|arm64)
    sealos_arch="arm64"
    ;;
  *)
    echo "Unsupported architecture: ${arch}" >&2
    exit 1
    ;;
esac

cd "${tmp_dir}"
until curl -sSfLo sealos.tar.gz "https://github.com/labring/sealos/releases/download/${SEALOS_VERSION}/sealos_${SEALOS_VERSION#v}_linux_${sealos_arch}.tar.gz"; do
  sleep 3
done

tar -zxf sealos.tar.gz sealos
chmod +x sealos
mv sealos /usr/bin/sealos
sealos version
