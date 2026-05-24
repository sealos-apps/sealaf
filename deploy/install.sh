#!/usr/bin/env bash
set -euo pipefail

timestamp() {
  date +"%Y-%m-%d %T"
}

info() {
  echo -e "\033[36m INFO [$(timestamp)] >> $* \033[0m"
}

warn() {
  echo -e "\033[33m WARN [$(timestamp)] >> $* \033[0m"
}

error() {
  echo -e "\033[31m ERROR [$(timestamp)] >> $* \033[0m"
  exit 1
}

get_sealos_config() {
  local key=$1
  kubectl get configmap sealos-config -n sealos-system -o "jsonpath={.data.${key}}" 2>/dev/null || true
}

decode_base64() {
  local raw=$1

  if printf '%s' "${raw}" | base64 --decode 2>/dev/null; then
    return 0
  fi

  if printf '%s' "${raw}" | base64 -d 2>/dev/null; then
    return 0
  fi

  return 1
}

get_secret_data() {
  local secret_name=$1
  local key=$2
  local encoded=""

  encoded="$(kubectl get secret "${secret_name}" -n "${NAMESPACE}" -o "jsonpath={.data.${key}}" 2>/dev/null || true)"
  [ -n "${encoded}" ] || return 1

  decode_base64 "${encoded}"
}

secret_exists() {
  local secret_name=$1
  kubectl get secret "${secret_name}" -n "${NAMESPACE}" >/dev/null 2>&1
}

resource_owner_release() {
  local namespace=$1
  local kind=$2
  local name=$3

  if [ -n "${namespace}" ]; then
    kubectl -n "${namespace}" get "${kind}" "${name}" -o "jsonpath={.metadata.annotations.meta\\.helm\\.sh/release-name}" 2>/dev/null || true
  else
    kubectl get "${kind}" "${name}" -o "jsonpath={.metadata.annotations.meta\\.helm\\.sh/release-name}" 2>/dev/null || true
  fi
}

resource_owner_namespace() {
  local namespace=$1
  local kind=$2
  local name=$3

  if [ -n "${namespace}" ]; then
    kubectl -n "${namespace}" get "${kind}" "${name}" -o "jsonpath={.metadata.annotations.meta\\.helm\\.sh/release-namespace}" 2>/dev/null || true
  else
    kubectl get "${kind}" "${name}" -o "jsonpath={.metadata.annotations.meta\\.helm\\.sh/release-namespace}" 2>/dev/null || true
  fi
}

validate_adoption_target() {
  local namespace=$1
  local kind=$2
  local name=$3
  local current_release current_namespace

  current_release="$(resource_owner_release "${namespace}" "${kind}" "${name}")"
  current_namespace="$(resource_owner_namespace "${namespace}" "${kind}" "${name}")"

  if [ -z "${current_release}${current_namespace}" ]; then
    return
  fi

  if [ "${current_release}" = "${RELEASE_NAME}" ] && [ "${current_namespace}" = "${NAMESPACE}" ]; then
    return
  fi

  if [ "${SEALAF_FORCE_ADOPT}" = "true" ]; then
    warn "Force adopting ${kind}/${name}; previous Helm owner was ${current_release}/${current_namespace}"
    return
  fi

  error "Refuse to adopt ${kind}/${name}; it is already owned by Helm release ${current_release}/${current_namespace}. Set SEALAF_FORCE_ADOPT=true to override."
}

adopt_namespaced_resource() {
  local namespace=$1
  local kind=$2
  local name=$3

  if kubectl -n "${namespace}" get "${kind}" "${name}" >/dev/null 2>&1; then
    validate_adoption_target "${namespace}" "${kind}" "${name}"
    info "Adopting ${kind}/${name} in namespace ${namespace}"
    kubectl -n "${namespace}" label "${kind}" "${name}" app.kubernetes.io/managed-by=Helm --overwrite >/dev/null
    kubectl -n "${namespace}" annotate "${kind}" "${name}" \
      meta.helm.sh/release-name="${RELEASE_NAME}" \
      meta.helm.sh/release-namespace="${NAMESPACE}" \
      --overwrite >/dev/null
  fi
}

adopt_cluster_resource() {
  local kind=$1
  local name=$2

  if kubectl get "${kind}" "${name}" >/dev/null 2>&1; then
    validate_adoption_target "" "${kind}" "${name}"
    info "Adopting cluster resource ${kind}/${name}"
    kubectl label "${kind}" "${name}" app.kubernetes.io/managed-by=Helm --overwrite >/dev/null
    kubectl annotate "${kind}" "${name}" \
      meta.helm.sh/release-name="${RELEASE_NAME}" \
      meta.helm.sh/release-namespace="${NAMESPACE}" \
      --overwrite >/dev/null
  fi
}

backup_namespaced_resource() {
  local namespace=$1
  local kind=$2
  local name=$3

  if kubectl -n "${namespace}" get "${kind}" "${name}" >/dev/null 2>&1; then
    kubectl -n "${namespace}" get "${kind}" "${name}" -o yaml >> "${SEALAF_BACKUP_FILE}"
    printf "\n---\n" >> "${SEALAF_BACKUP_FILE}"
  fi
}

backup_cluster_resource() {
  local kind=$1
  local name=$2

  if kubectl get "${kind}" "${name}" >/dev/null 2>&1; then
    kubectl get "${kind}" "${name}" -o yaml >> "${SEALAF_BACKUP_FILE}"
    printf "\n---\n" >> "${SEALAF_BACKUP_FILE}"
  fi
}

backup_sealaf_resources() {
  local ts

  if [ "${SEALAF_BACKUP_ENABLED}" != "true" ]; then
    return
  fi

  ts="$(date +%Y%m%d%H%M%S)"
  mkdir -p "${SEALAF_BACKUP_DIR}"
  SEALAF_BACKUP_FILE="${SEALAF_BACKUP_DIR}/adopt-${ts}.yaml"
  : > "${SEALAF_BACKUP_FILE}"

  backup_namespaced_resource "${NAMESPACE}" serviceaccount sealaf-sa
  backup_namespaced_resource "${NAMESPACE}" secret sealaf-config
  backup_namespaced_resource "${NAMESPACE}" service sealaf-web
  backup_namespaced_resource "${NAMESPACE}" service sealaf-server
  backup_namespaced_resource "${NAMESPACE}" deployment sealaf-web
  backup_namespaced_resource "${NAMESPACE}" deployment sealaf-server
  backup_namespaced_resource "${NAMESPACE}" ingress sealaf-web
  backup_namespaced_resource "${NAMESPACE}" ingress sealaf-server
  backup_namespaced_resource app-system app sealaf
  backup_cluster_resource clusterrole sealaf-role
  backup_cluster_resource clusterrolebinding sealaf-rolebinding

  if [ -s "${SEALAF_BACKUP_FILE}" ]; then
    info "Backed up existing resources to ${SEALAF_BACKUP_FILE}"
  else
    rm -f "${SEALAF_BACKUP_FILE}"
  fi
}

adopt_existing_resources() {
  if [ "${SEALAF_ADOPT_EXISTING_RESOURCES}" != "true" ]; then
    return
  fi

  if is_existing_release; then
    return
  fi

  backup_sealaf_resources

  adopt_namespaced_resource "${NAMESPACE}" serviceaccount sealaf-sa
  adopt_namespaced_resource "${NAMESPACE}" secret sealaf-config
  adopt_namespaced_resource "${NAMESPACE}" service sealaf-web
  adopt_namespaced_resource "${NAMESPACE}" service sealaf-server
  adopt_namespaced_resource "${NAMESPACE}" deployment sealaf-web
  adopt_namespaced_resource "${NAMESPACE}" deployment sealaf-server
  adopt_namespaced_resource "${NAMESPACE}" ingress sealaf-web
  adopt_namespaced_resource "${NAMESPACE}" ingress sealaf-server

  if [ "${ENABLE_APP}" = "true" ]; then
    adopt_namespaced_resource app-system app sealaf
  fi

  adopt_cluster_resource clusterrole sealaf-role
  adopt_cluster_resource clusterrolebinding sealaf-rolebinding
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  tr -cd 'a-z0-9' </dev/urandom | head -c 64 || true
}

escape_helm_set_string() {
  local value=$1
  value="${value//\\/\\\\}"
  value="${value//,/\\,}"
  printf '%s' "${value}"
}

is_existing_release() {
  helm status "${RELEASE_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1
}

detect_mongodb_api_mode() {
  if [ "${MONGODB_API_MODE}" != "auto" ]; then
    printf '%s' "${MONGODB_API_MODE}"
    return
  fi

  if kubectl explain cluster.spec.componentSpecs.serviceVersion --api-version=apps.kubeblocks.io/v1alpha1 >/dev/null 2>&1; then
    printf '%s' "serviceVersion"
  else
    printf '%s' "clusterVersionRef"
  fi
}

mongodb_replica_set() {
  printf '%s-%s' "${MONGODB_CLUSTER_NAME}" "${MONGODB_COMPONENT_NAME}"
}

build_mongodb_uri_from_conn_credential() {
  local secret_name=${1:-${MONGODB_CONN_CREDENTIAL_SECRET}}
  local username password endpoint host port

  secret_exists "${secret_name}" || return 1
  username="$(get_secret_data "${secret_name}" username || true)"
  password="$(get_secret_data "${secret_name}" password || true)"
  endpoint="$(get_secret_data "${secret_name}" headlessEndpoint || true)"

  if [ -z "${endpoint}" ]; then
    endpoint="$(get_secret_data "${secret_name}" endpoint || true)"
  fi

  if [ -z "${endpoint}" ]; then
    host="$(get_secret_data "${secret_name}" headlessHost || true)"
    port="$(get_secret_data "${secret_name}" headlessPort || true)"
    if [ -z "${host}" ]; then
      host="$(get_secret_data "${secret_name}" host || true)"
      port="$(get_secret_data "${secret_name}" port || true)"
    fi
    [ -n "${host}" ] && [ -n "${port}" ] || return 1
    endpoint="${host}:${port}"
  fi

  [ -n "${username}" ] && [ -n "${password}" ] && [ -n "${endpoint}" ] || return 1
  printf 'mongodb://%s:%s@%s/%s?authSource=admin&replicaSet=%s&w=majority' \
    "${username}" "${password}" "${endpoint}" "${MONGODB_DATABASE}" "$(mongodb_replica_set)"
}

build_mongodb_uri_from_account_root() {
  local secret_name=${1:-${MONGODB_ACCOUNT_ROOT_SECRET}}
  local username password host

  secret_exists "${secret_name}" || return 1
  username="$(get_secret_data "${secret_name}" username || true)"
  password="$(get_secret_data "${secret_name}" password || true)"
  [ -n "${username}" ] && [ -n "${password}" ] || return 1

  host="${MONGODB_CLUSTER_NAME}-${MONGODB_COMPONENT_NAME}.${NAMESPACE}.svc:${MONGODB_PORT}"
  printf 'mongodb://%s:%s@%s/%s?authSource=admin&replicaSet=%s&w=majority' \
    "${username}" "${password}" "${host}" "${MONGODB_DATABASE}" "$(mongodb_replica_set)"
}

resolve_existing_mongodb_uri() {
  local uri=""

  if uri="$(build_mongodb_uri_from_conn_credential "${MONGODB_CONN_CREDENTIAL_SECRET}" 2>/dev/null)"; then
    mongodb_uri_source="secret:${MONGODB_CONN_CREDENTIAL_SECRET}"
    MONGODB_SECRET_TYPE="connCredential"
    RESOLVED_MONGODB_URI="${uri}"
    return 0
  fi

  if uri="$(build_mongodb_uri_from_account_root "${MONGODB_ACCOUNT_ROOT_SECRET}" 2>/dev/null)"; then
    mongodb_uri_source="secret:${MONGODB_ACCOUNT_ROOT_SECRET}"
    MONGODB_SECRET_TYPE="accountRoot"
    RESOLVED_MONGODB_URI="${uri}"
    return 0
  fi

  if uri="$(get_secret_data sealaf-config DATABASE_URL || true)"; [ -n "${uri}" ]; then
    mongodb_uri_source="secret:sealaf-config"
    MONGODB_SECRET_TYPE="config"
    RESOLVED_MONGODB_URI="${uri}"
    return 0
  fi

  return 1
}

apply_mongodb_cluster() {
  local values_args=()

  kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

  if [ -f "${VALUES_FILE}" ]; then
    values_args=(-f "${VALUES_FILE}")
  fi

  info "Applying MongoDB Cluster ${MONGODB_CLUSTER_NAME} with apiMode=${RESOLVED_MONGODB_API_MODE}"
  helm template "${RELEASE_NAME}" "${CHART_DIR}" -n "${NAMESPACE}" \
    "${values_args[@]}" \
    --show-only templates/mongodb.yaml \
    --set-string "mongodb.apiMode=${RESOLVED_MONGODB_API_MODE}" \
    --set-string "mongodb.clusterName=${MONGODB_CLUSTER_NAME}" \
    --set-string "mongodb.clusterDefinitionRef=${MONGODB_CLUSTER_DEFINITION_REF}" \
    --set-string "mongodb.clusterVersionRef=${MONGODB_CLUSTER_VERSION_REF}" \
    --set-string "mongodb.componentName=${MONGODB_COMPONENT_NAME}" \
    --set-string "mongodb.serviceVersion=${MONGODB_SERVICE_VERSION}" \
    --set-string "mongodb.database=${MONGODB_DATABASE}" \
    --set "mongodb.port=${MONGODB_PORT}" \
    | kubectl apply -f -
}

ensure_mongodb_uri() {
  local deadline

  if [ -n "${MONGODB_URI}" ]; then
    mongodb_uri_source="${mongodb_uri_source:-env}"
    return
  fi

  if resolve_existing_mongodb_uri; then
    MONGODB_URI="${RESOLVED_MONGODB_URI}"
    return
  fi

  if kubectl get cluster "${MONGODB_CLUSTER_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1; then
    info "MongoDB Cluster ${MONGODB_CLUSTER_NAME} already exists, waiting for credential Secret"
  else
    apply_mongodb_cluster
  fi

  deadline=$((SECONDS + MONGODB_SECRET_WAIT_TIMEOUT))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if resolve_existing_mongodb_uri; then
      MONGODB_URI="${RESOLVED_MONGODB_URI}"
      return
    fi
    sleep 2
  done

  error "Timed out waiting for MongoDB credentials. Checked ${MONGODB_CONN_CREDENTIAL_SECRET}, ${MONGODB_ACCOUNT_ROOT_SECRET}, and sealaf-config"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="${CHART_DIR:-${SCRIPT_DIR}/charts/sealaf}"

RELEASE_NAME="${RELEASE_NAME:-sealaf}"
NAMESPACE="${NAMESPACE:-sealaf-system}"
HELM_OPTS="${HELM_OPTS:-}"
ENABLE_APP="${ENABLE_APP:-true}"
STRICT_SECRET_REUSE="${STRICT_SECRET_REUSE:-true}"
SEALAF_ADOPT_EXISTING_RESOURCES="${SEALAF_ADOPT_EXISTING_RESOURCES:-true}"
SEALAF_FORCE_ADOPT="${SEALAF_FORCE_ADOPT:-false}"
SEALAF_BACKUP_ENABLED="${SEALAF_BACKUP_ENABLED:-true}"
SEALAF_BACKUP_DIR="${SEALAF_BACKUP_DIR:-/tmp/sealos-backup/sealaf}"
SEALAF_BACKUP_FILE="${SEALAF_BACKUP_FILE:-}"

CLOUD_DOMAIN="${CLOUD_DOMAIN:-${cloudDomain:-}}"
CLOUD_PORT="${CLOUD_PORT:-${cloudPort:-}}"
CERT_SECRET_NAME="${CERT_SECRET_NAME:-${certSecretName:-wildcard-cert}}"
MONGODB_URI="${MONGODB_URI:-${mongodbUri:-}}"
APP_MONITOR_URL="${APP_MONITOR_URL:-${appMonitorUrl:-http://launchpad-monitor.sealos.svc.cluster.local:8428/query}}"
DATABASE_MONITOR_URL="${DATABASE_MONITOR_URL:-${databaseMonitorUrl:-http://database-monitor.sealos.svc.cluster.local:9090/query}}"
RUNTIME_INIT_IMAGE="${RUNTIME_INIT_IMAGE:-${runtimeInitImage:-docker.io/lafyun/runtime-node-init:latest}}"
RUNTIME_IMAGE="${RUNTIME_IMAGE:-${runtimeImage:-docker.io/lafyun/runtime-node:latest}}"
VALUES_FILE="${VALUES_FILE:-/root/.sealos/cloud/values/apps/sealaf/sealaf-values.yaml}"

MONGODB_CLUSTER_NAME="${MONGODB_CLUSTER_NAME:-${mongodbClusterName:-sealaf-mongodb}}"
MONGODB_COMPONENT_NAME="${MONGODB_COMPONENT_NAME:-${mongodbComponentName:-mongodb}}"
MONGODB_DATABASE="${MONGODB_DATABASE:-${mongodbDatabase:-sys_db}}"
MONGODB_PORT="${MONGODB_PORT:-${mongodbPort:-27017}}"
MONGODB_SERVICE_VERSION="${MONGODB_SERVICE_VERSION:-${mongodbServiceVersion:-8.0.4}}"
MONGODB_CLUSTER_DEFINITION_REF="${MONGODB_CLUSTER_DEFINITION_REF:-${mongodbClusterDefinitionRef:-mongodb}}"
MONGODB_CLUSTER_VERSION_REF="${MONGODB_CLUSTER_VERSION_REF:-${mongodbClusterVersionRef:-mongodb-5.0}}"
MONGODB_API_MODE="${MONGODB_API_MODE:-${mongodbApiMode:-auto}}"
MONGODB_CONN_CREDENTIAL_SECRET="${MONGODB_CONN_CREDENTIAL_SECRET:-${mongodbConnCredentialSecret:-${MONGODB_CLUSTER_NAME}-conn-credential}}"
MONGODB_ACCOUNT_ROOT_SECRET="${MONGODB_ACCOUNT_ROOT_SECRET:-${mongodbAccountRootSecret:-${MONGODB_CLUSTER_NAME}-account-root}}"
MONGODB_SECRET_WAIT_TIMEOUT="${MONGODB_SECRET_WAIT_TIMEOUT:-${mongodbSecretWaitTimeout:-600}}"
MONGODB_SECRET_TYPE="${MONGODB_SECRET_TYPE:-}"
mongodb_uri_source="${mongodb_uri_source:-}"
RESOLVED_MONGODB_URI="${RESOLVED_MONGODB_URI:-}"
RESOLVED_MONGODB_API_MODE="$(detect_mongodb_api_mode)"

if [ -z "${CLOUD_DOMAIN}" ]; then
  CLOUD_DOMAIN="$(get_sealos_config cloudDomain)"
fi

if [ -z "${CLOUD_DOMAIN}" ]; then
  warn "cloudDomain not found in env or sealos-config, using 127.0.0.1.nip.io"
  CLOUD_DOMAIN="127.0.0.1.nip.io"
fi

server_jwt_secret="${SERVER_JWT_SECRET:-}"
server_jwt_source="env"
release_exists="false"
if is_existing_release; then
  release_exists="true"
fi

if [ -z "${server_jwt_secret}" ]; then
  server_jwt_secret="$(get_secret_data sealaf-config SERVER_JWT_SECRET || true)"
  if [ -n "${server_jwt_secret}" ]; then
    server_jwt_source="secret:sealaf-config"
  else
    server_jwt_source="generated"
  fi
fi

if [ "${release_exists}" = "true" ] && [ "${STRICT_SECRET_REUSE}" = "true" ] && [ "${server_jwt_source}" = "generated" ]; then
  error "Existing release ${RELEASE_NAME} detected, but SERVER_JWT_SECRET was not found. Refuse to generate a new key when STRICT_SECRET_REUSE=true"
fi

if [ -z "${server_jwt_secret}" ]; then
  warn "SERVER_JWT_SECRET not found, generating a new one"
  server_jwt_secret="$(generate_secret)"
fi

info "Secret reuse summary: server_jwt_source=${server_jwt_source}, strict_reuse=${STRICT_SECRET_REUSE}"
ensure_mongodb_uri
info "MongoDB credential summary: source=${mongodb_uri_source}, secret_type=${MONGODB_SECRET_TYPE:-provided}, apiMode=${RESOLVED_MONGODB_API_MODE}"
adopt_existing_resources

helm_set_args=(
  --set-string "cloudDomain=${CLOUD_DOMAIN}"
  --set-string "cloudPort=${CLOUD_PORT}"
  --set-string "certSecretName=${CERT_SECRET_NAME}"
  --set-string "serverJwtSecret=${server_jwt_secret}"
  --set-string "appMonitorUrl=${APP_MONITOR_URL}"
  --set-string "databaseMonitorUrl=${DATABASE_MONITOR_URL}"
  --set-string "runtimeInitImage=${RUNTIME_INIT_IMAGE}"
  --set-string "runtimeImage=${RUNTIME_IMAGE}"
  --set-string "mongodb.apiMode=${RESOLVED_MONGODB_API_MODE}"
  --set-string "mongodb.clusterName=${MONGODB_CLUSTER_NAME}"
  --set-string "mongodb.clusterDefinitionRef=${MONGODB_CLUSTER_DEFINITION_REF}"
  --set-string "mongodb.clusterVersionRef=${MONGODB_CLUSTER_VERSION_REF}"
  --set-string "mongodb.componentName=${MONGODB_COMPONENT_NAME}"
  --set-string "mongodb.serviceVersion=${MONGODB_SERVICE_VERSION}"
  --set-string "mongodb.database=${MONGODB_DATABASE}"
  --set "mongodb.port=${MONGODB_PORT}"
)

if [ -n "${MONGODB_URI}" ]; then
  helm_set_args+=(--set-string "mongodb.externalUri=$(escape_helm_set_string "${MONGODB_URI}")")
fi

if [ "${ENABLE_APP}" = "true" ]; then
  helm_set_args+=(--set "app.enabled=true")
fi

helm_opts_arr=()
if [ -n "${HELM_OPTS}" ]; then
  # shellcheck disable=SC2206
  helm_opts_arr=(${HELM_OPTS})
fi

if [ -f "${VALUES_FILE}" ]; then
  info "Using additional Helm values from ${VALUES_FILE}"
  helm_set_args+=(-f "${VALUES_FILE}")
else
  warn "Values file ${VALUES_FILE} not found, proceeding without it"
fi

info "Installing chart ${CHART_DIR} into namespace ${NAMESPACE}"
helm upgrade -i "${RELEASE_NAME}" -n "${NAMESPACE}" --create-namespace "${CHART_DIR}" \
  "${helm_set_args[@]}" \
  "${helm_opts_arr[@]}" \
  --wait
