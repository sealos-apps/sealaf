#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${TEST_DIR}/.." && pwd)"

PLATFORM_TOOLS_FILE=/nonexistent
# shellcheck source=../install.sh
source "${DEPLOY_DIR}/install.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

DEPLOYMENT_VERSION=""
COMPONENT_VERSIONS_OUTPUT=""
kubectl() {
  if [[ "$*" == *"componentversions.apps.kubeblocks.io"* ]]; then
    printf '%s' "${COMPONENT_VERSIONS_OUTPUT}"
    return
  fi
  printf '%s' "${DEPLOYMENT_VERSION}"
}

assert_equal() {
  local expected=$1
  local actual=$2
  local message=$3

  [ "${actual}" = "${expected}" ] || fail "${message}: expected '${expected}', got '${actual}'"
}

assert_equal kb8 "$(kubeblocks_template_from_version 0.8.2)" "KB 0.8 mapping"
assert_equal kb9 "$(kubeblocks_template_from_version 0.9.3)" "KB 0.9 mapping"

MONGODB_API_MODE=auto
assert_equal clusterVersionRef "$(resolve_mongodb_api_mode kb8)" "KB8 API mode"
assert_equal serviceVersion "$(resolve_mongodb_api_mode kb9)" "KB9 API mode"

MONGODB_API_MODE=serviceVersion
if (resolve_mongodb_api_mode kb8 >/dev/null 2>&1); then
  fail "KB8 accepted incompatible serviceVersion API mode"
fi

read_yaml_file_path() {
  case "$1" in
    .global.featureConfigs.database.kubeblocksVersion) printf '%s' 0.9.3 ;;
    .global.database.kubeblocksVersion) printf '%s' 0.8.2 ;;
  esac
}
assert_equal kb9 "$(detect_kubeblocks_template_version 2>/dev/null)" "new global values path precedence"

DEPLOYMENT_VERSION="0.8.2 docker.io/apecloud/kubeblocks:0.8.2"
if (detect_kubeblocks_template_version >/dev/null 2>&1); then
  fail "global KB9 configuration accepted conflicting KB8 deployment metadata"
fi
DEPLOYMENT_VERSION=""

read_yaml_file_path() {
  case "$1" in
    .global.database.kubeblocksVersion) printf '%s' 0.8.2 ;;
  esac
}
assert_equal kb8 "$(detect_kubeblocks_template_version 2>/dev/null)" "legacy global values path fallback"

MONGODB_COMPONENT_NAME=mongodb
MONGODB_SERVICE_VERSION=8.0.4
COMPONENT_VERSIONS_OUTPUT='5.0.30,7.0.16,8.0.4'
validate_kubeblocks_prerequisites_for_kb9() {
  RESOLVED_KUBEBLOCKS_TEMPLATE_VERSION=kb9
  validate_kubeblocks_prerequisites
}
validate_kubeblocks_prerequisites_for_kb9

COMPONENT_VERSIONS_OUTPUT='5.0.30,7.0.16'
if (validate_kubeblocks_prerequisites_for_kb9 >/dev/null 2>&1); then
  fail "KB9 accepted an unavailable MongoDB serviceVersion"
fi

echo "KubeBlocks resolution tests passed"
