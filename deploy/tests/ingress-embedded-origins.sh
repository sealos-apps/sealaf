#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="${TEST_DIR}/../charts/sealaf"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local content=$1
  local expected=$2
  local message=$3

  grep -Fq -- "${expected}" <<< "${content}" || fail "${message}: missing '${expected}'"
}

assert_not_contains() {
  local content=$1
  local unexpected=$2
  local message=$3

  if grep -Fq -- "${unexpected}" <<< "${content}"; then
    fail "${message}: found '${unexpected}'"
  fi
}

expected_csp() {
  local embedded_origin=${1:-}
  local suffix=""

  if [ -n "${embedded_origin}" ]; then
    suffix=" ${embedded_origin}"
  fi

  printf "%s" "default-src * blob: data: *.127.0.0.1.nip.io 127.0.0.1.nip.io; img-src * data: blob: resource: *.127.0.0.1.nip.io 127.0.0.1.nip.io; connect-src * wss: blob: resource:; style-src 'self' 'unsafe-inline' blob: *.127.0.0.1.nip.io 127.0.0.1.nip.io resource:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: *.127.0.0.1.nip.io 127.0.0.1.nip.io resource: *.baidu.com *.bdstatic.com; frame-src 'self' *.127.0.0.1.nip.io 127.0.0.1.nip.io mailto: tel: weixin: mtt: *.baidu.com; frame-ancestors 'self' https://127.0.0.1.nip.io https://*.127.0.0.1.nip.io${suffix}"
}

assert_response_headers() {
  local rendered=$1
  local embedded_origin=${2:-}
  local csp

  csp="$(expected_csp "${embedded_origin}")"
  assert_contains "${rendered}" 'more_clear_headers "X-Frame-Options:";' "NGINX clears X-Frame-Options"
  assert_contains "${rendered}" 'higress.io/response-header-control-remove: X-Frame-Options' "Higress removes X-Frame-Options"
  assert_not_contains "${rendered}" 'more_set_headers "X-Frame-Options:' "NGINX does not set X-Frame-Options"
  assert_contains "${rendered}" "more_set_headers \"Content-Security-Policy: ${csp}\";" "NGINX retains and updates CSP"
  assert_contains "${rendered}" "Content-Security-Policy \"${csp}\"" "Higress retains and updates CSP"
}

assert_invalid_origin_rejected() {
  local origin=$1

  if helm template sealaf "${CHART_DIR}" --set-string "ingress.embeddedAllowedOrigins[0]=${origin}" >/dev/null 2>&1; then
    fail "invalid embedded origin was accepted: ${origin}"
  fi
}

helm lint "${CHART_DIR}" >/dev/null

default_rendered="$(helm template sealaf "${CHART_DIR}")"
assert_response_headers "${default_rendered}"

http_origin="http://province.example.com:8080"
http_rendered="$(helm template sealaf "${CHART_DIR}" --set-string "ingress.embeddedAllowedOrigins[0]=${http_origin}")"
assert_response_headers "${http_rendered}" "${http_origin}"

https_origin="https://province.example.com"
https_rendered="$(helm template sealaf "${CHART_DIR}" --set-string "ingress.embeddedAllowedOrigins[0]=${https_origin}")"
assert_response_headers "${https_rendered}" "${https_origin}"

assert_invalid_origin_rejected '*'
assert_invalid_origin_rejected 'https://*.example.com'
assert_invalid_origin_rejected 'https://province.example.com/path'
assert_invalid_origin_rejected 'province.example.com'

echo "Embedded Ingress origin rendering tests passed"
