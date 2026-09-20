#!/usr/bin/env bash
set -euo pipefail

PLATFORM_TOOLS_FILE="${PLATFORM_TOOLS_FILE:-/root/.sealos/cloud/scripts/tools.sh}"
if [ -r "${PLATFORM_TOOLS_FILE}" ]; then
  # shellcheck source=/dev/null
  source "${PLATFORM_TOOLS_FILE}"
fi

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
  echo -e "\033[31m ERROR [$(timestamp)] >> $* \033[0m" >&2
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

initialize_mongodb_secret_names() {
  MONGODB_CONN_CREDENTIAL_SECRET="${MONGODB_CONN_CREDENTIAL_SECRET:-${mongodbConnCredentialSecret:-${MONGODB_CLUSTER_NAME}-conn-credential}}"
  MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET="${MONGODB_CLUSTER_NAME}-${MONGODB_COMPONENT_NAME}-account-root"
  MONGODB_LEGACY_ACCOUNT_ROOT_SECRET="${MONGODB_CLUSTER_NAME}-account-root"
  MONGODB_ACCOUNT_ROOT_SECRET="${MONGODB_ACCOUNT_ROOT_SECRET:-${mongodbAccountRootSecret:-${MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET}}}"
}

mongodb_account_root_secret_candidates() {
  local secret_name
  local seen=" "

  for secret_name in \
    "${MONGODB_ACCOUNT_ROOT_SECRET:-}" \
    "${MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET:-}" \
    "${MONGODB_LEGACY_ACCOUNT_ROOT_SECRET:-}"; do
    [ -n "${secret_name}" ] || continue
    case "${seen}" in
      *" ${secret_name} "*) continue ;;
    esac
    printf '%s\n' "${secret_name}"
    seen="${seen}${secret_name} "
  done
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
  local secret_name ts

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
  backup_namespaced_resource "${NAMESPACE}" cluster.apps.kubeblocks.io "${MONGODB_CLUSTER_NAME:-sealaf-mongodb}"
  backup_namespaced_resource "${NAMESPACE}" secret "${MONGODB_CONN_CREDENTIAL_SECRET:-sealaf-mongodb-conn-credential}"
  while IFS= read -r secret_name; do
    backup_namespaced_resource "${NAMESPACE}" secret "${secret_name}"
  done < <(mongodb_account_root_secret_candidates)
  backup_namespaced_resource "${NAMESPACE}" pvc "data-${MONGODB_CLUSTER_NAME:-sealaf-mongodb}-${MONGODB_COMPONENT_NAME:-mongodb}-0"
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
    if [ "${MONGODB_MANAGE_CLUSTER}" = "true" ]; then
      backup_sealaf_resources
      adopt_namespaced_resource "${NAMESPACE}" cluster.apps.kubeblocks.io "${MONGODB_CLUSTER_NAME}"
    fi
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
  adopt_namespaced_resource "${NAMESPACE}" cluster.apps.kubeblocks.io "${MONGODB_CLUSTER_NAME}"

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

kubeblocks_template_from_version() {
  local version=${1#v}

  case "${version}" in
    0.8.*|8.*)
      printf '%s' "kb8"
      ;;
    0.9.*|9.*)
      printf '%s' "kb9"
      ;;
    *)
      return 1
      ;;
  esac
}

read_configured_kubeblocks_version() {
  local version=""

  if declare -F read_yaml_file_path >/dev/null 2>&1; then
    version="$(read_yaml_file_path '.global.featureConfigs.database.kubeblocksVersion' 2>/dev/null || true)"
    if [ -z "${version}" ]; then
      version="$(read_yaml_file_path '.global.database.kubeblocksVersion' 2>/dev/null || true)"
    fi
  fi

  printf '%s' "${version}"
}

resolve_mongodb_api_mode() {
  local template_version=$1
  local expected_mode

  case "${template_version}" in
    kb8) expected_mode="clusterVersionRef" ;;
    kb9) expected_mode="serviceVersion" ;;
    *) error "Unsupported resolved KubeBlocks template version: ${template_version}" ;;
  esac

  case "${MONGODB_API_MODE}" in
    auto)
      printf '%s' "${expected_mode}"
      ;;
    "${expected_mode}")
      printf '%s' "${MONGODB_API_MODE}"
      ;;
    serviceVersion|clusterVersionRef)
      error "MONGODB_API_MODE=${MONGODB_API_MODE} conflicts with KUBEBLOCKS_TEMPLATE_VERSION=${template_version}; expected ${expected_mode}."
      ;;
    *)
      error "Unsupported MONGODB_API_MODE=${MONGODB_API_MODE}. Expected auto, serviceVersion, or clusterVersionRef."
      ;;
  esac
}

detect_kubeblocks_template_version() {
  local version configured_version configured_template deployed_template=""

  configured_version="$(read_configured_kubeblocks_version)"
  version="$(kubectl get deployment kubeblocks -n kb-system -o jsonpath='{.metadata.labels.app\.kubernetes\.io/version}{" "}{.spec.template.spec.containers[*].image}' 2>/dev/null || true)"
  if [ -z "${version}" ]; then
    version="$(
      kubectl get deployments -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{" "}{.metadata.labels.app\.kubernetes\.io/version}{" "}{.spec.template.spec.containers[*].image}{"\n"}{end}' 2>/dev/null |
        awk '/kubeblocks/ { print; exit }' || true
    )"
  fi

  if [[ "${version}" =~ (^|[^0-9])(0\.[89]\.[0-9]+|[89]\.[0-9]+) ]]; then
    if ! deployed_template="$(kubeblocks_template_from_version "${BASH_REMATCH[2]}")"; then
      error "Unable to map detected KubeBlocks version ${BASH_REMATCH[2]}"
    fi
  fi

  if [ -n "${configured_version}" ]; then
    if ! configured_template="$(kubeblocks_template_from_version "${configured_version}")"; then
      error "Unsupported global KubeBlocks version ${configured_version}. Expected 0.8.x or 0.9.x."
    fi
    if [ -n "${deployed_template}" ] && [ "${configured_template}" != "${deployed_template}" ]; then
      error "KubeBlocks version mismatch: global values specify ${configured_version} (${configured_template}), but deployment metadata indicates ${deployed_template}: ${version}"
    fi
    info "Resolved KubeBlocks ${configured_version} from global values as ${configured_template}" >&2
    printf '%s' "${configured_template}"
    return
  fi

  if [ -n "${deployed_template}" ]; then
    info "Resolved KubeBlocks from deployment metadata as ${deployed_template}: ${version}" >&2
    printf '%s' "${deployed_template}"
    return
  fi

  error "Unable to determine KubeBlocks 0.8/0.9 version from global values or deployment metadata. Set KUBEBLOCKS_TEMPLATE_VERSION explicitly after verifying the installed addon."
}

resolve_kubeblocks_template_version() {
  case "${KUBEBLOCKS_TEMPLATE_VERSION}" in
    kb8|kb9)
      printf '%s' "${KUBEBLOCKS_TEMPLATE_VERSION}"
      ;;
    auto)
      detect_kubeblocks_template_version
      ;;
    *)
      echo -e "\033[31m ERROR [$(timestamp)] >> Unsupported KUBEBLOCKS_TEMPLATE_VERSION=${KUBEBLOCKS_TEMPLATE_VERSION}. Expected auto, kb8, or kb9. \033[0m" >&2
      exit 1
      ;;
  esac
}

validate_kubeblocks_prerequisites() {
  local component_versions normalized_component_versions

  kubectl get crd clusters.apps.kubeblocks.io >/dev/null 2>&1 ||
    error "KubeBlocks Cluster CRD clusters.apps.kubeblocks.io is not installed."

  case "${RESOLVED_KUBEBLOCKS_TEMPLATE_VERSION}" in
    kb8)
      kubectl get clusterdefinitions.apps.kubeblocks.io "${MONGODB_CLUSTER_DEFINITION_REF}" >/dev/null 2>&1 ||
        error "KubeBlocks ClusterDefinition ${MONGODB_CLUSTER_DEFINITION_REF} is not installed."
      kubectl get clusterversions.apps.kubeblocks.io "${MONGODB_CLUSTER_VERSION_REF}" >/dev/null 2>&1 ||
        error "KubeBlocks ClusterVersion ${MONGODB_CLUSTER_VERSION_REF} is not installed."
      ;;
    kb9)
      kubectl get componentdefinitions.apps.kubeblocks.io "${MONGODB_COMPONENT_NAME}" >/dev/null 2>&1 ||
        error "KubeBlocks ComponentDefinition ${MONGODB_COMPONENT_NAME} is not installed."
      kubectl get componentversions.apps.kubeblocks.io "${MONGODB_COMPONENT_NAME}" >/dev/null 2>&1 ||
        error "KubeBlocks ComponentVersion ${MONGODB_COMPONENT_NAME} is not installed."
      component_versions="$(
        kubectl get componentversions.apps.kubeblocks.io "${MONGODB_COMPONENT_NAME}" \
          -o jsonpath='{.status.serviceVersions}{"\n"}{range .spec.compatibilityRules[*].releases[*]}{.}{"\n"}{end}{range .spec.releases[*]}{.serviceVersion}{"\n"}{end}' \
          2>/dev/null || true
      )"
      normalized_component_versions="$(
        printf '%s\n' "${component_versions}" |
          tr ',[]"' '\n' |
          tr '[:space:]' '\n'
      )"
      if ! grep -Fxq "${MONGODB_SERVICE_VERSION}" <<< "${normalized_component_versions}"; then
        error "MongoDB ComponentVersion ${MONGODB_COMPONENT_NAME} does not provide serviceVersion=${MONGODB_SERVICE_VERSION}. Available versions: ${component_versions:-none}"
      fi
      ;;
  esac
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
  local secret_name uri=""

  if uri="$(build_mongodb_uri_from_conn_credential "${MONGODB_CONN_CREDENTIAL_SECRET}" 2>/dev/null)"; then
    mongodb_uri_source="secret:${MONGODB_CONN_CREDENTIAL_SECRET}"
    MONGODB_SECRET_TYPE="connCredential"
    RESOLVED_MONGODB_URI="${uri}"
    return 0
  fi

  while IFS= read -r secret_name; do
    if uri="$(build_mongodb_uri_from_account_root "${secret_name}" 2>/dev/null)"; then
      mongodb_uri_source="secret:${secret_name}"
      MONGODB_SECRET_TYPE="accountRoot"
      RESOLVED_MONGODB_URI="${uri}"
      return 0
    fi
  done < <(mongodb_account_root_secret_candidates)

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

  info "Applying MongoDB Cluster ${MONGODB_CLUSTER_NAME} with apiMode=${RESOLVED_MONGODB_API_MODE}, templateVersion=${RESOLVED_KUBEBLOCKS_TEMPLATE_VERSION}"
  helm template "${RELEASE_NAME}" "${CHART_DIR}" -n "${NAMESPACE}" \
    "${values_args[@]}" \
    --show-only templates/mongodb.yaml \
    --set-string "kubeblocks.templateVersion=${RESOLVED_KUBEBLOCKS_TEMPLATE_VERSION}" \
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

  error "Timed out waiting for MongoDB credentials. Checked ${MONGODB_CONN_CREDENTIAL_SECRET}, ${MONGODB_ACCOUNT_ROOT_SECRET}, ${MONGODB_COMPONENT_ACCOUNT_ROOT_SECRET}, ${MONGODB_LEGACY_ACCOUNT_ROOT_SECRET}, and sealaf-config"
}

delete_namespaced_resource() {
  local namespace=$1
  local kind=$2
  local name=$3

  if kubectl -n "${namespace}" get "${kind}" "${name}" >/dev/null 2>&1; then
    info "Deleting ${kind}/${name} in namespace ${namespace}"
    if ! kubectl -n "${namespace}" delete "${kind}" "${name}" --ignore-not-found --wait=true --timeout="${UNINSTALL_TIMEOUT}" >/dev/null; then
      warn "Failed to delete ${kind}/${name} in namespace ${namespace}"
      return 1
    fi
  fi
}

delete_cluster_resource() {
  local kind=$1
  local name=$2

  if kubectl get "${kind}" "${name}" >/dev/null 2>&1; then
    info "Deleting cluster resource ${kind}/${name}"
    if ! kubectl delete "${kind}" "${name}" --ignore-not-found --wait=true --timeout="${UNINSTALL_TIMEOUT}" >/dev/null; then
      warn "Failed to delete cluster resource ${kind}/${name}"
      return 1
    fi
  fi
}

cleanup_known_application_resources() {
  local failed=0

  delete_namespaced_resource "${NAMESPACE}" serviceaccount sealaf-sa || failed=1
  delete_namespaced_resource "${NAMESPACE}" secret sealaf-config || failed=1
  delete_namespaced_resource "${NAMESPACE}" service sealaf-web || failed=1
  delete_namespaced_resource "${NAMESPACE}" service sealaf-server || failed=1
  delete_namespaced_resource "${NAMESPACE}" deployment sealaf-web || failed=1
  delete_namespaced_resource "${NAMESPACE}" deployment sealaf-server || failed=1
  delete_namespaced_resource "${NAMESPACE}" ingress sealaf-web || failed=1
  delete_namespaced_resource "${NAMESPACE}" ingress sealaf-server || failed=1
  delete_namespaced_resource app-system app sealaf || failed=1
  delete_cluster_resource clusterrole sealaf-role || failed=1
  delete_cluster_resource clusterrolebinding sealaf-rolebinding || failed=1

  return "${failed}"
}

delete_mongodb_pvcs() {
  local pvc pvc_prefix failed=0

  pvc_prefix="data-${MONGODB_CLUSTER_NAME}-${MONGODB_COMPONENT_NAME}-"
  for pvc in $(kubectl -n "${NAMESPACE}" get pvc -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep "^${pvc_prefix}" || true); do
    delete_namespaced_resource "${NAMESPACE}" pvc "${pvc}" || failed=1
  done

  kubectl -n "${NAMESPACE}" delete pvc \
    -l "app.kubernetes.io/instance=${MONGODB_CLUSTER_NAME}" \
    --ignore-not-found --wait=true --timeout="${UNINSTALL_TIMEOUT}" >/dev/null 2>&1 || failed=1
  kubectl -n "${NAMESPACE}" delete pvc \
    -l "apps.kubeblocks.io/cluster-name=${MONGODB_CLUSTER_NAME}" \
    --ignore-not-found --wait=true --timeout="${UNINSTALL_TIMEOUT}" >/dev/null 2>&1 || failed=1

  return "${failed}"
}

delete_prefixed_namespaced_resources() {
  local namespace=$1
  local kind=$2
  local prefix=$3
  local name failed=0

  for name in $(kubectl -n "${namespace}" get "${kind}" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep "^${prefix}" || true); do
    delete_namespaced_resource "${namespace}" "${kind}" "${name}" || failed=1
  done

  return "${failed}"
}

cleanup_internal_mongodb() {
  local secret_name failed=0

  if [ "${SEALAF_UNINSTALL_DELETE_DATABASE}" != "true" ]; then
    warn "Skipping MongoDB deletion because SEALAF_UNINSTALL_DELETE_DATABASE=${SEALAF_UNINSTALL_DELETE_DATABASE}"
    return
  fi

  delete_namespaced_resource "${NAMESPACE}" cluster.apps.kubeblocks.io "${MONGODB_CLUSTER_NAME}" || failed=1
  delete_namespaced_resource "${NAMESPACE}" statefulset "${MONGODB_CLUSTER_NAME}-${MONGODB_COMPONENT_NAME}" || failed=1
  delete_namespaced_resource "${NAMESPACE}" service "${MONGODB_CLUSTER_NAME}-${MONGODB_COMPONENT_NAME}" || failed=1
  delete_namespaced_resource "${NAMESPACE}" service "${MONGODB_CLUSTER_NAME}-${MONGODB_COMPONENT_NAME}-headless" || failed=1
  delete_namespaced_resource "${NAMESPACE}" secret "${MONGODB_CONN_CREDENTIAL_SECRET}" || failed=1
  while IFS= read -r secret_name; do
    delete_namespaced_resource "${NAMESPACE}" secret "${secret_name}" || failed=1
  done < <(mongodb_account_root_secret_candidates)
  delete_namespaced_resource "${NAMESPACE}" serviceaccount "${MONGODB_SERVICE_ACCOUNT_NAME}" || failed=1
  delete_mongodb_pvcs || failed=1
  delete_prefixed_namespaced_resources "${NAMESPACE}" configmap "${MONGODB_CLUSTER_NAME}-${MONGODB_COMPONENT_NAME}" || failed=1
  delete_prefixed_namespaced_resources "${NAMESPACE}" secret "${MONGODB_CLUSTER_NAME}-${MONGODB_COMPONENT_NAME}" || failed=1

  kubectl -n "${NAMESPACE}" delete configmap \
    -l "app.kubernetes.io/instance=${MONGODB_CLUSTER_NAME}" \
    --ignore-not-found --wait=true --timeout="${UNINSTALL_TIMEOUT}" >/dev/null 2>&1 || failed=1
  kubectl -n "${NAMESPACE}" delete configmap \
    -l "apps.kubeblocks.io/cluster-name=${MONGODB_CLUSTER_NAME}" \
    --ignore-not-found --wait=true --timeout="${UNINSTALL_TIMEOUT}" >/dev/null 2>&1 || failed=1

  return "${failed}"
}

remove_helm_release_metadata() {
  kubectl -n "${NAMESPACE}" delete secret,configmap \
    -l "owner=helm,name=${RELEASE_NAME}" \
    --ignore-not-found >/dev/null 2>&1 || true
}

release_mongodb_from_helm() {
  if kubectl -n "${NAMESPACE}" get cluster.apps.kubeblocks.io "${MONGODB_CLUSTER_NAME}" >/dev/null 2>&1; then
    kubectl -n "${NAMESPACE}" annotate cluster.apps.kubeblocks.io "${MONGODB_CLUSTER_NAME}" \
      meta.helm.sh/release-name- meta.helm.sh/release-namespace- >/dev/null 2>&1 || true
    kubectl -n "${NAMESPACE}" label cluster.apps.kubeblocks.io "${MONGODB_CLUSTER_NAME}" \
      app.kubernetes.io/managed-by- >/dev/null 2>&1 || true
  fi
}

uninstall_sealaf() {
  local uninstall_failed=false helm_cleanup_required=false

  if [ "${SEALAF_DELETE_NAMESPACE}" = "true" ] && [ "${SEALAF_UNINSTALL_DELETE_DATABASE}" != "true" ]; then
    error "SEALAF_DELETE_NAMESPACE=true conflicts with SEALAF_UNINSTALL_DELETE_DATABASE=false; refusing to delete a namespace that contains the preserved database."
  fi

  info "Starting full Sealaf uninstall for release ${RELEASE_NAME} in namespace ${NAMESPACE}"
  backup_sealaf_resources

  if [ "${SEALAF_UNINSTALL_DELETE_DATABASE}" = "true" ]; then
    if ! cleanup_internal_mongodb; then
      warn "MongoDB cleanup did not complete; continuing application cleanup"
      uninstall_failed=true
    fi
  else
    info "Preserving MongoDB Cluster ${MONGODB_CLUSTER_NAME} and its data"
  fi

  if is_existing_release && [ "${SEALAF_UNINSTALL_DELETE_DATABASE}" = "true" ]; then
    info "Uninstalling Helm release ${RELEASE_NAME}"
    if ! helm uninstall "${RELEASE_NAME}" -n "${NAMESPACE}" --no-hooks --timeout "${UNINSTALL_TIMEOUT}"; then
      warn "Helm uninstall failed; continuing known-resource cleanup"
      helm_cleanup_required=true
    fi
  elif is_existing_release; then
    warn "Removing Helm-managed application resources manually so MongoDB can be preserved"
  else
    warn "Helm release ${RELEASE_NAME} not found in namespace ${NAMESPACE}, cleaning known resources"
  fi

  if ! cleanup_known_application_resources; then
    warn "Some known Sealaf application resources could not be deleted"
    uninstall_failed=true
  fi

  if [ "${SEALAF_UNINSTALL_DELETE_DATABASE}" != "true" ]; then
    release_mongodb_from_helm
    remove_helm_release_metadata
  elif [ "${helm_cleanup_required}" = "true" ]; then
    remove_helm_release_metadata
    if is_existing_release; then
      warn "Helm release metadata for ${RELEASE_NAME} still exists"
      uninstall_failed=true
    fi
  fi

  if [ "${SEALAF_DELETE_NAMESPACE}" = "true" ]; then
    if ! delete_cluster_resource namespace "${NAMESPACE}"; then
      warn "Namespace ${NAMESPACE} could not be deleted"
      uninstall_failed=true
    fi
  fi

  if [ "${uninstall_failed}" = "true" ]; then
    error "Sealaf uninstall finished with residual resources. Inspect namespace ${NAMESPACE} and KubeBlocks finalizers."
  fi

  info "Sealaf uninstall completed"
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="${CHART_DIR:-${SCRIPT_DIR}/charts/sealaf}"

RELEASE_NAME="${RELEASE_NAME:-sealaf}"
NAMESPACE="${NAMESPACE:-sealaf-system}"
SEALAF_ACTION="${SEALAF_ACTION:-${ACTION:-install}}"
HELM_OPTS="${HELM_OPTS:-}"
ENABLE_APP="${ENABLE_APP:-true}"
STRICT_SECRET_REUSE="${STRICT_SECRET_REUSE:-true}"
SEALAF_ADOPT_EXISTING_RESOURCES="${SEALAF_ADOPT_EXISTING_RESOURCES:-true}"
SEALAF_FORCE_ADOPT="${SEALAF_FORCE_ADOPT:-false}"
SEALAF_BACKUP_ENABLED="${SEALAF_BACKUP_ENABLED:-true}"
SEALAF_BACKUP_DIR="${SEALAF_BACKUP_DIR:-/tmp/sealos-backup/sealaf}"
SEALAF_BACKUP_FILE="${SEALAF_BACKUP_FILE:-}"
SEALAF_UNINSTALL_DELETE_DATABASE="${SEALAF_UNINSTALL_DELETE_DATABASE:-true}"
SEALAF_DELETE_NAMESPACE="${SEALAF_DELETE_NAMESPACE:-false}"
UNINSTALL_TIMEOUT="${UNINSTALL_TIMEOUT:-10m}"

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
MONGODB_SERVICE_ACCOUNT_NAME="${MONGODB_SERVICE_ACCOUNT_NAME:-${mongodbServiceAccountName:-${MONGODB_CLUSTER_NAME}}}"
MONGODB_MANAGE_CLUSTER="${MONGODB_MANAGE_CLUSTER:-${mongodbManageCluster:-}}"
MONGODB_API_MODE="${MONGODB_API_MODE:-${mongodbApiMode:-auto}}"
KUBEBLOCKS_TEMPLATE_VERSION="${KUBEBLOCKS_TEMPLATE_VERSION:-${kubeblocksTemplateVersion:-auto}}"
initialize_mongodb_secret_names
MONGODB_SECRET_WAIT_TIMEOUT="${MONGODB_SECRET_WAIT_TIMEOUT:-${mongodbSecretWaitTimeout:-600}}"
MONGODB_SECRET_TYPE="${MONGODB_SECRET_TYPE:-}"
mongodb_uri_source="${mongodb_uri_source:-}"
RESOLVED_MONGODB_URI="${RESOLVED_MONGODB_URI:-}"
RESOLVED_MONGODB_API_MODE=""
RESOLVED_KUBEBLOCKS_TEMPLATE_VERSION=""

if [ -z "${MONGODB_MANAGE_CLUSTER}" ]; then
  if [ -n "${MONGODB_URI}" ]; then
    MONGODB_MANAGE_CLUSTER="false"
  else
    MONGODB_MANAGE_CLUSTER="true"
  fi
fi

case "${SEALAF_ACTION}" in
  install|upgrade)
    RESOLVED_KUBEBLOCKS_TEMPLATE_VERSION="$(resolve_kubeblocks_template_version)"
    RESOLVED_MONGODB_API_MODE="$(resolve_mongodb_api_mode "${RESOLVED_KUBEBLOCKS_TEMPLATE_VERSION}")"
    validate_kubeblocks_prerequisites
    ;;
  uninstall)
    uninstall_sealaf
    exit 0
    ;;
  *)
    error "Unsupported SEALAF_ACTION=${SEALAF_ACTION}. Expected install, upgrade, or uninstall."
    ;;
esac

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
info "MongoDB credential summary: source=${mongodb_uri_source}, secret_type=${MONGODB_SECRET_TYPE:-provided}, apiMode=${RESOLVED_MONGODB_API_MODE}, templateVersion=${RESOLVED_KUBEBLOCKS_TEMPLATE_VERSION}"
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
  --set-string "kubeblocks.templateVersion=${RESOLVED_KUBEBLOCKS_TEMPLATE_VERSION}"
  --set-string "mongodb.apiMode=${RESOLVED_MONGODB_API_MODE}"
  --set-string "mongodb.clusterName=${MONGODB_CLUSTER_NAME}"
  --set-string "mongodb.clusterDefinitionRef=${MONGODB_CLUSTER_DEFINITION_REF}"
  --set-string "mongodb.clusterVersionRef=${MONGODB_CLUSTER_VERSION_REF}"
  --set-string "mongodb.componentName=${MONGODB_COMPONENT_NAME}"
  --set-string "mongodb.serviceVersion=${MONGODB_SERVICE_VERSION}"
  --set-string "mongodb.database=${MONGODB_DATABASE}"
  --set "mongodb.port=${MONGODB_PORT}"
  --set "mongodb.manageCluster=${MONGODB_MANAGE_CLUSTER}"
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
