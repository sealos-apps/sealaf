#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${TEST_DIR}/.." && pwd)"

# shellcheck source=../install.sh
source "${DEPLOY_DIR}/install.sh"

declare -A SECRET_DATA=()

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_equal() {
  local expected=$1
  local actual=$2
  local message=$3

  if [ "${actual}" != "${expected}" ]; then
    fail "${message}: expected '${expected}', got '${actual}'"
  fi
}

set_secret_value() {
  local secret_name=$1
  local key=$2
  local value=$3
  SECRET_DATA["${secret_name}:${key}"]="${value}"
}

secret_exists() {
  local secret_name=$1
  [[ -v "SECRET_DATA[${secret_name}:username]" ]]
}

get_secret_data() {
  local secret_name=$1
  local key=$2
  local data_key="${secret_name}:${key}"

  [[ -v "SECRET_DATA[${data_key}]" ]] || return 1
  printf '%s' "${SECRET_DATA[${data_key}]}"
}

reset_mongodb_config() {
  SECRET_DATA=()
  NAMESPACE="sealaf-system"
  MONGODB_CLUSTER_NAME="sealaf-mongodb"
  MONGODB_COMPONENT_NAME="mongodb"
  MONGODB_DATABASE="sys_db"
  MONGODB_PORT="27017"
  MONGODB_CONN_CREDENTIAL_SECRET="sealaf-mongodb-conn-credential"
  MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET="sealaf-mongodb-mongodb-account-root"
  MONGODB_LEGACY_ACCOUNT_ROOT_SECRET="sealaf-mongodb-account-root"
  MONGODB_ACCOUNT_ROOT_SECRET="${MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET}"
  MONGODB_SECRET_TYPE=""
  RESOLVED_MONGODB_URI=""
  mongodb_uri_source=""
}

test_default_secret_names() {
  local -a candidates

  MONGODB_CLUSTER_NAME="sealaf-mongodb"
  MONGODB_COMPONENT_NAME="mongodb"
  unset MONGODB_CONN_CREDENTIAL_SECRET
  unset MONGODB_ACCOUNT_ROOT_SECRET
  unset MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET
  unset MONGODB_LEGACY_ACCOUNT_ROOT_SECRET
  unset mongodbConnCredentialSecret
  unset mongodbAccountRootSecret

  initialize_mongodb_secret_names
  mapfile -t candidates < <(mongodb_account_root_secret_candidates)

  assert_equal "sealaf-mongodb-conn-credential" "${MONGODB_CONN_CREDENTIAL_SECRET}" "default conn-credential Secret"
  assert_equal "sealaf-mongodb-mongodb-account-root" "${MONGODB_ACCOUNT_ROOT_SECRET}" "default KB9 account-root Secret"
  assert_equal "2" "${#candidates[@]}" "deduplicated account-root candidate count"
  assert_equal "sealaf-mongodb-mongodb-account-root" "${candidates[0]}" "first account-root candidate"
  assert_equal "sealaf-mongodb-account-root" "${candidates[1]}" "legacy account-root candidate"
}

test_kb9_component_account_root() {
  reset_mongodb_config
  set_secret_value "${MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET}" username root
  set_secret_value "${MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET}" password password

  resolve_existing_mongodb_uri || fail "KB9 component account-root Secret was not resolved"

  assert_equal "secret:sealaf-mongodb-mongodb-account-root" "${mongodb_uri_source}" "KB9 Secret source"
  assert_equal "accountRoot" "${MONGODB_SECRET_TYPE}" "KB9 Secret type"
  assert_equal \
    "mongodb://root:password@sealaf-mongodb-mongodb.sealaf-system.svc:27017/sys_db?authSource=admin&replicaSet=sealaf-mongodb-mongodb&w=majority" \
    "${RESOLVED_MONGODB_URI}" \
    "KB9 MongoDB URI"
}

test_legacy_account_root_fallback() {
  reset_mongodb_config
  set_secret_value "${MONGODB_LEGACY_ACCOUNT_ROOT_SECRET}" username legacy
  set_secret_value "${MONGODB_LEGACY_ACCOUNT_ROOT_SECRET}" password password

  resolve_existing_mongodb_uri || fail "legacy account-root Secret was not resolved"

  assert_equal "secret:sealaf-mongodb-account-root" "${mongodb_uri_source}" "legacy Secret source"
}

test_explicit_account_root_precedence() {
  reset_mongodb_config
  MONGODB_ACCOUNT_ROOT_SECRET="custom-root-secret"
  set_secret_value "${MONGODB_ACCOUNT_ROOT_SECRET}" username custom
  set_secret_value "${MONGODB_ACCOUNT_ROOT_SECRET}" password password
  set_secret_value "${MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET}" username component
  set_secret_value "${MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET}" password password

  resolve_existing_mongodb_uri || fail "explicit account-root Secret was not resolved"

  assert_equal "secret:custom-root-secret" "${mongodb_uri_source}" "explicit Secret precedence"
}

test_conn_credential_compatibility() {
  reset_mongodb_config
  set_secret_value "${MONGODB_CONN_CREDENTIAL_SECRET}" username conn
  set_secret_value "${MONGODB_CONN_CREDENTIAL_SECRET}" password password
  set_secret_value "${MONGODB_CONN_CREDENTIAL_SECRET}" headlessEndpoint mongo.example:27017
  set_secret_value "${MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET}" username component
  set_secret_value "${MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET}" password password

  resolve_existing_mongodb_uri || fail "conn-credential Secret was not resolved"

  assert_equal "secret:sealaf-mongodb-conn-credential" "${mongodb_uri_source}" "conn-credential precedence"
  assert_equal "connCredential" "${MONGODB_SECRET_TYPE}" "conn-credential type"
}

test_helm_root_secret_names() {
  local kb8_rendered kb9_rendered

  helm lint "${DEPLOY_DIR}/charts/sealaf" >/dev/null || fail "Helm chart lint failed"

  kb9_rendered="$(
    helm template sealaf "${DEPLOY_DIR}/charts/sealaf" \
      --set-string mongodb.clusterName=test-cluster \
      --set-string mongodb.componentName=docdb \
      --set-string kubeblocks.templateVersion=kb9
  )"

  grep -q 'name: test-cluster-docdb-account-root' <<< "${kb9_rendered}" ||
    fail "KB9 Helm Deployment does not reference the component account-root Secret"

  kb8_rendered="$(
    helm template sealaf "${DEPLOY_DIR}/charts/sealaf" \
      --set-string mongodb.clusterName=test-cluster \
      --set-string mongodb.componentName=docdb \
      --set-string kubeblocks.templateVersion=kb8
  )"

  grep -q 'name: test-cluster-account-root' <<< "${kb8_rendered}" ||
    fail "KB8 Helm Deployment does not retain the legacy account-root Secret"
}

test_default_secret_names
test_kb9_component_account_root
test_legacy_account_root_fallback
test_explicit_account_root_precedence
test_conn_credential_compatibility
test_helm_root_secret_names

echo "MongoDB Secret resolution tests passed"
