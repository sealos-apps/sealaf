#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${TEST_DIR}/.." && pwd)"

PLATFORM_TOOLS_FILE=/nonexistent
# shellcheck source=../install.sh
source "${DEPLOY_DIR}/install.sh"

EVENTS=()
RELEASE_EXISTS=true
HELM_FAIL=false

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

backup_sealaf_resources() { EVENTS+=(backup); }
cleanup_internal_mongodb() { EVENTS+=(database); }
cleanup_known_application_resources() { EVENTS+=(application); }
is_existing_release() { [ "${RELEASE_EXISTS}" = "true" ]; }
helm() {
  EVENTS+=(helm)
  if [ "${HELM_FAIL}" = "true" ]; then
    return 1
  fi
  RELEASE_EXISTS=false
}
release_mongodb_from_helm() { EVENTS+=(release-database); }
remove_helm_release_metadata() {
  EVENTS+=(release-metadata)
  RELEASE_EXISTS=false
}

RELEASE_NAME=sealaf
NAMESPACE=sealaf-system
MONGODB_CLUSTER_NAME=sealaf-mongodb
UNINSTALL_TIMEOUT=10m
SEALAF_BACKUP_ENABLED=false
SEALAF_DELETE_NAMESPACE=false

SEALAF_UNINSTALL_DELETE_DATABASE=true
uninstall_sealaf >/dev/null
[ "${EVENTS[*]}" = "backup database helm application" ] ||
  fail "delete-database uninstall order was '${EVENTS[*]}'"

EVENTS=()
RELEASE_EXISTS=true
SEALAF_UNINSTALL_DELETE_DATABASE=false
uninstall_sealaf >/dev/null
[ "${EVENTS[*]}" = "backup application release-database release-metadata" ] ||
  fail "preserve-database uninstall order was '${EVENTS[*]}'"

EVENTS=()
SEALAF_DELETE_NAMESPACE=true
if (uninstall_sealaf >/dev/null 2>&1); then
  fail "preserve-database uninstall accepted namespace deletion"
fi
[ "${#EVENTS[@]}" -eq 0 ] || fail "namespace/database conflict mutated resources before failing"

EVENTS=()
RELEASE_EXISTS=true
HELM_FAIL=true
SEALAF_DELETE_NAMESPACE=false
SEALAF_UNINSTALL_DELETE_DATABASE=true
uninstall_sealaf >/dev/null
[ "${EVENTS[*]}" = "backup database helm application release-metadata" ] ||
  fail "failed-Helm fallback order was '${EVENTS[*]}'"

echo "Uninstall flow tests passed"
