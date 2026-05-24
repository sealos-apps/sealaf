{{/*
Expand the name of the chart.
*/}}
{{- define "sealaf.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "sealaf.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "sealaf.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "sealaf.labels" -}}
helm.sh/chart: {{ include "sealaf.chart" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "sealaf.webName" -}}
{{- default "sealaf-web" .Values.web.name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "sealaf.serverName" -}}
{{- default "sealaf-server" .Values.server.name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "sealaf.webSelectorLabels" -}}
app: {{ include "sealaf.webName" . }}
app.kubernetes.io/name: {{ include "sealaf.webName" . }}
{{- end }}

{{- define "sealaf.serverSelectorLabels" -}}
app: {{ include "sealaf.serverName" . }}
app.kubernetes.io/name: {{ include "sealaf.serverName" . }}
{{- end }}

{{- define "sealaf.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default "sealaf-sa" .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "sealaf.configSecretName" -}}
{{- if .Values.secret.existingSecret }}
{{- .Values.secret.existingSecret }}
{{- else }}
{{- default "sealaf-config" .Values.secret.name }}
{{- end }}
{{- end }}

{{- define "sealaf.domainWithPort" -}}
{{- $port := (toString .Values.cloudPort) | trimPrefix ":" -}}
{{- if $port -}}
{{- printf "%s:%s" .Values.cloudDomain $port -}}
{{- else -}}
{{- .Values.cloudDomain -}}
{{- end -}}
{{- end }}

{{- define "sealaf.webHost" -}}
{{- printf "sealaf.%s" .Values.cloudDomain -}}
{{- end }}

{{- define "sealaf.apiHost" -}}
{{- printf "sealaf-api.%s" .Values.cloudDomain -}}
{{- end }}

{{- define "sealaf.webUrl" -}}
{{- $port := (toString .Values.cloudPort) | trimPrefix ":" -}}
{{- if $port -}}
{{- printf "https://%s:%s" (include "sealaf.webHost" .) $port -}}
{{- else -}}
{{- printf "https://%s" (include "sealaf.webHost" .) -}}
{{- end -}}
{{- end }}

{{- define "sealaf.apiUrl" -}}
{{- $port := (toString .Values.cloudPort) | trimPrefix ":" -}}
{{- if $port -}}
{{- printf "https://%s:%s" (include "sealaf.apiHost" .) $port -}}
{{- else -}}
{{- printf "https://%s" (include "sealaf.apiHost" .) -}}
{{- end -}}
{{- end }}

{{- define "sealaf.contentSecurityPolicy" -}}
{{- $domain := include "sealaf.domainWithPort" . -}}
{{- printf "default-src * blob: data: *.%s %s; img-src * data: blob: resource: *.%s %s; connect-src * wss: blob: resource:; style-src 'self' 'unsafe-inline' blob: *.%s %s resource:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: *.%s %s resource: *.baidu.com *.bdstatic.com; frame-src 'self' *.%s %s mailto: tel: weixin: mtt: *.baidu.com; frame-ancestors 'self' https://%s https://*.%s" $domain $domain $domain $domain $domain $domain $domain $domain $domain $domain $domain $domain -}}
{{- end }}

{{- define "sealaf.mongodbRootSecretName" -}}
{{- printf "%s-account-root" .Values.mongodb.clusterName -}}
{{- end }}

{{- define "sealaf.mongodbHost" -}}
{{- printf "%s-%s.%s.svc" .Values.mongodb.clusterName .Values.mongodb.componentName .Release.Namespace -}}
{{- end }}

{{- define "sealaf.mongodbUriTemplate" -}}
{{- printf "mongodb://$(MONGODB_USERNAME):$(MONGODB_PASSWORD)@%s:%v/%s?authSource=admin&replicaSet=%s-%s&w=majority" (include "sealaf.mongodbHost" .) .Values.mongodb.port .Values.mongodb.database .Values.mongodb.clusterName .Values.mongodb.componentName -}}
{{- end }}
