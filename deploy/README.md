# Sealaf Helm 部署说明

本文档说明 Sealaf Helm 部署包的使用方式、`sealos run` 可传参数、旧版资源接管、后续 Helm 更新和删除流程。

## 基本概念

部署入口是 `deploy/install.sh`，镜像的 `Kubefile` 默认执行该脚本。正常情况下推荐用 `sealos run` 执行部署镜像：

```bash
sealos run <sealaf-image>
```

`sealos run` 支持用 `-e, --env` 传递环境变量，格式如下：

```bash
sealos run <sealaf-image> -e KEY=value -e OTHER_KEY=other-value
```

脚本最终执行 Helm：

```bash
helm upgrade -i "${RELEASE_NAME}" -n "${NAMESPACE}" --create-namespace "${CHART_DIR}" \
  "${helm_set_args[@]}" \
  "${helm_opts_arr[@]}" \
  --wait
```

含义：

- `helm upgrade -i`: release 存在则升级，不存在则安装。
- `RELEASE_NAME`: Helm release 名，默认 `sealaf`。
- `NAMESPACE`: 安装命名空间，默认 `sealaf-system`。
- `--create-namespace`: 命名空间不存在时自动创建。
- `CHART_DIR`: Chart 路径，默认是部署包内的 `charts/sealaf`。
- `helm_set_args`: 脚本自动生成的 `--set` / `--set-string` 参数。
- `HELM_OPTS`: 通过 `sealos run -e HELM_OPTS=...` 传入的额外 Helm 参数。
- `--wait`: 等待 Kubernetes 资源 ready 后再退出。

## 初始安装

全新环境直接执行：

```bash
sealos run <sealaf-image>
```

脚本会自动完成：

- 读取或设置 `cloudDomain`。
- 生成或复用 `SERVER_JWT_SECRET`。
- 查找 MongoDB 凭据 Secret 并生成 `DATABASE_URL`。
- 如 MongoDB Cluster 不存在，先创建 MongoDB，再等待凭据 Secret。
- 安装或升级 Helm release `sealaf`。

手动指定域名：

```bash
sealos run <sealaf-image> \
  -e CLOUD_DOMAIN=example.com \
  -e CLOUD_PORT=443
```

手动指定外部 MongoDB：

```bash
sealos run <sealaf-image> \
  -e MONGODB_URI='mongodb://user:pass@host:27017/sys_db?authSource=admin&replicaSet=sealaf-mongodb-mongodb&w=majority'
```

传递额外 Helm 参数：

```bash
sealos run <sealaf-image> \
  -e HELM_OPTS='--timeout 10m --debug'
```

## 已有旧版资源的接管和升级

旧版脚本通过 `kubectl apply` 创建资源，不带 Helm ownership。直接执行 Helm 会报类似错误：

```text
invalid ownership metadata;
missing app.kubernetes.io/managed-by=Helm;
missing meta.helm.sh/release-name;
missing meta.helm.sh/release-namespace
```

当前安装脚本默认开启旧资源接管：

```text
SEALAF_ADOPT_EXISTING_RESOURCES=true
SEALAF_BACKUP_ENABLED=true
```

接管时脚本会先备份旧资源到：

```text
/tmp/sealos-backup/sealaf/adopt-<timestamp>.yaml
```

然后给旧资源补 Helm 标记：

```text
app.kubernetes.io/managed-by=Helm
meta.helm.sh/release-name=sealaf
meta.helm.sh/release-namespace=sealaf-system
```

迁移旧版资源时执行：

```bash
sealos run <sealaf-image> \
  -e SEALAF_ADOPT_EXISTING_RESOURCES=true \
  -e SEALAF_BACKUP_ENABLED=true \
  -e HELM_OPTS='--timeout 10m'
```

如果只想做无副作用参数和模板验证，不接管旧资源：

```bash
sealos run <sealaf-image> \
  -e SEALAF_ADOPT_EXISTING_RESOURCES=false \
  -e HELM_OPTS='--dry-run --debug'
```

注意：如果旧资源存在且未被 Helm 管理，关闭接管后 dry-run 可能仍会因为 ownership 校验失败。这种失败说明 Helm 接管是必要步骤。

默认接管范围：

```text
sealaf-system/serviceaccount/sealaf-sa
sealaf-system/secret/sealaf-config
sealaf-system/service/sealaf-web
sealaf-system/service/sealaf-server
sealaf-system/deployment/sealaf-web
sealaf-system/deployment/sealaf-server
sealaf-system/ingress/sealaf-web
sealaf-system/ingress/sealaf-server
app-system/app/sealaf
clusterrole/sealaf-role
clusterrolebinding/sealaf-rolebinding
```

默认不接管 `sealaf-mongodb` Cluster。原因是脚本会把数据库连接串作为 `mongodb.externalUri` 传给 Helm，MongoDB Cluster 保持在 Helm release 外部，避免升级或卸载应用时误改或误删数据库。

如果资源已经属于另一个 Helm release，脚本默认拒绝抢占。确认要覆盖旧 owner 时才使用：

```bash
sealos run <sealaf-image> \
  -e SEALAF_FORCE_ADOPT=true
```

## 后续 Helm 管理

查看 release：

```bash
helm status sealaf -n sealaf-system
helm list -n sealaf-system
```

查看历史：

```bash
helm history sealaf -n sealaf-system
```

推荐更新方式：

```bash
sealos run <new-sealaf-image>
```

也可以直接用 Helm 更新，但需要确保当前 release 已经完成首次脚本安装，并且 release values 中已有脚本写入的配置：

```bash
helm upgrade sealaf deploy/charts/sealaf -n sealaf-system --reuse-values --wait
```

回滚：

```bash
helm rollback sealaf <REVISION> -n sealaf-system --wait
```

删除应用：

```bash
helm uninstall sealaf -n sealaf-system
```

`helm uninstall` 会删除 Helm 管理的 Sealaf 应用资源。默认不会删除 `sealaf-mongodb` Cluster，也不会删除其 PVC。数据库如需删除，需要单独确认后手动处理。

## MongoDB 凭据获取逻辑

如果未显式传入 `MONGODB_URI`，脚本按以下顺序生成连接串：

1. 读取 `${MONGODB_CLUSTER_NAME}-conn-credential`，默认 `sealaf-mongodb-conn-credential`。
   - 使用 `username`、`password`、`headlessEndpoint`。
   - 如果没有 `headlessEndpoint`，fallback 到 `endpoint`。
   - 如果仍没有，fallback 到 `headlessHost + headlessPort` 或 `host + port`。
2. 读取 `${MONGODB_CLUSTER_NAME}-account-root`，默认 `sealaf-mongodb-account-root`。
   - 使用 `username`、`password`。
   - host 拼为 `${MONGODB_CLUSTER_NAME}-${MONGODB_COMPONENT_NAME}.${NAMESPACE}.svc:${MONGODB_PORT}`。
3. 读取 `sealaf-config.DATABASE_URL`。
4. 如果 MongoDB Cluster 不存在，先创建 MongoDB Cluster，然后等待凭据 Secret。

最终连接串格式：

```text
mongodb://<username>:<password>@<endpoint>/<database>?authSource=admin&replicaSet=<cluster>-<component>&w=majority
```

默认数据库名是 `sys_db`。

## 参数完整说明

### Helm 和安装流程参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `RELEASE_NAME` | `sealaf` | Helm release 名。 |
| `NAMESPACE` | `sealaf-system` | Helm release namespace。 |
| `CHART_DIR` | 脚本目录下 `charts/sealaf` | Chart 路径。通常不需要在 `sealos run` 中修改。 |
| `HELM_OPTS` | 空 | 额外 Helm 参数，如 `--timeout 10m --debug`。 |
| `VALUES_FILE` | `/root/.sealos/cloud/values/apps/sealaf/sealaf-values.yaml` | 额外 values 文件路径；存在时会传给 Helm。 |
| `ENABLE_APP` | `true` | 是否创建 `app-system` 下的 Sealos App CR。 |

### 旧资源接管和备份参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `SEALAF_ADOPT_EXISTING_RESOURCES` | `true` | 首次 Helm 安装前是否给旧资源补 Helm ownership。 |
| `SEALAF_FORCE_ADOPT` | `false` | 是否强制接管已经属于其他 Helm release 的资源。 |
| `SEALAF_BACKUP_ENABLED` | `true` | 接管前是否备份旧资源 YAML。 |
| `SEALAF_BACKUP_DIR` | `/tmp/sealos-backup/sealaf` | 备份目录。 |
| `SEALAF_BACKUP_FILE` | 自动生成 | 指定备份文件路径；通常不需要设置。 |

### 基础配置参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOUD_DOMAIN` | `sealos-config.cloudDomain`，没有则 `127.0.0.1.nip.io` | 外部访问域名。兼容旧变量 `cloudDomain`。 |
| `CLOUD_PORT` | 空 | 外部访问端口。兼容旧变量 `cloudPort`。 |
| `CERT_SECRET_NAME` | `wildcard-cert` | Ingress TLS Secret 名。兼容旧变量 `certSecretName`。 |
| `APP_MONITOR_URL` | `http://launchpad-monitor.sealos.svc.cluster.local:8428/query` | 应用监控查询地址。兼容旧变量 `appMonitorUrl`。 |
| `DATABASE_MONITOR_URL` | `http://database-monitor.sealos.svc.cluster.local:9090/query` | 数据库监控查询地址。兼容旧变量 `databaseMonitorUrl`。 |
| `RUNTIME_INIT_IMAGE` | `docker.io/lafyun/runtime-node-init:latest` | 默认 runtime init 镜像。兼容旧变量 `runtimeInitImage`。 |
| `RUNTIME_IMAGE` | `docker.io/lafyun/runtime-node:latest` | 默认 runtime 镜像。兼容旧变量 `runtimeImage`。 |
| `SERVER_JWT_SECRET` | 自动复用或生成 | 指定 server JWT secret。未设置时优先复用 `sealaf-config.SERVER_JWT_SECRET`。 |
| `STRICT_SECRET_REUSE` | `true` | 已有 Helm release 但找不到旧 JWT Secret 时，是否拒绝生成新值。 |

### MongoDB 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `MONGODB_URI` | 空 | 手动指定完整 MongoDB URI。兼容旧变量 `mongodbUri`。 |
| `MONGODB_CLUSTER_NAME` | `sealaf-mongodb` | MongoDB Cluster 名。兼容旧变量 `mongodbClusterName`。 |
| `MONGODB_COMPONENT_NAME` | `mongodb` | MongoDB component 名。兼容旧变量 `mongodbComponentName`。 |
| `MONGODB_DATABASE` | `sys_db` | 应用数据库名。兼容旧变量 `mongodbDatabase`。 |
| `MONGODB_PORT` | `27017` | MongoDB 端口。兼容旧变量 `mongodbPort`。 |
| `MONGODB_API_MODE` | `auto` | KubeBlocks Cluster API 模式：`auto`、`serviceVersion`、`clusterVersionRef`。兼容旧变量 `mongodbApiMode`。 |
| `MONGODB_SERVICE_VERSION` | `8.0.4` | `serviceVersion` 模式使用的 MongoDB service version。兼容旧变量 `mongodbServiceVersion`。 |
| `MONGODB_CLUSTER_DEFINITION_REF` | `mongodb` | `clusterVersionRef` 模式使用的 ClusterDefinition。兼容旧变量 `mongodbClusterDefinitionRef`。 |
| `MONGODB_CLUSTER_VERSION_REF` | `mongodb-5.0` | `clusterVersionRef` 模式使用的 ClusterVersion。兼容旧变量 `mongodbClusterVersionRef`。 |
| `MONGODB_CONN_CREDENTIAL_SECRET` | `${MONGODB_CLUSTER_NAME}-conn-credential` | conn credential Secret 名。兼容旧变量 `mongodbConnCredentialSecret`。 |
| `MONGODB_ACCOUNT_ROOT_SECRET` | `${MONGODB_CLUSTER_NAME}-account-root` | account root Secret 名。兼容旧变量 `mongodbAccountRootSecret`。 |
| `MONGODB_SECRET_WAIT_TIMEOUT` | `600` | 等待 MongoDB 凭据 Secret 的超时时间，单位秒。兼容旧变量 `mongodbSecretWaitTimeout`。 |

### 内部和调试变量

以下变量主要用于脚本内部状态或调试，通常不要通过 `sealos run -e` 设置：

| 参数 | 说明 |
| --- | --- |
| `MONGODB_SECRET_TYPE` | 当前识别到的 MongoDB Secret 类型。 |
| `RESOLVED_MONGODB_URI` | 脚本内部生成的 MongoDB URI。 |
| `RESOLVED_MONGODB_API_MODE` | 自动探测后的 KubeBlocks API 模式。 |
| `mongodb_uri_source` | MongoDB URI 来源描述。 |

## 常用命令速查

全新安装：

```bash
sealos run <sealaf-image>
```

旧版迁移并接管资源：

```bash
sealos run <sealaf-image> \
  -e SEALAF_ADOPT_EXISTING_RESOURCES=true \
  -e SEALAF_BACKUP_ENABLED=true \
  -e HELM_OPTS='--timeout 10m'
```

指定外部 MongoDB：

```bash
sealos run <sealaf-image> \
  -e MONGODB_URI='mongodb://user:pass@host:27017/sys_db?authSource=admin&replicaSet=sealaf-mongodb-mongodb&w=majority'
```

强制使用旧 KubeBlocks API 模式：

```bash
sealos run <sealaf-image> \
  -e MONGODB_API_MODE=clusterVersionRef
```

强制使用新 KubeBlocks API 模式：

```bash
sealos run <sealaf-image> \
  -e MONGODB_API_MODE=serviceVersion
```

查看 Helm 状态：

```bash
helm status sealaf -n sealaf-system
```

卸载应用：

```bash
helm uninstall sealaf -n sealaf-system
```
