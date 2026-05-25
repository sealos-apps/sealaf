{{- define "sealaf.mongodb.kb9" -}}
apiVersion: apps.kubeblocks.io/v1alpha1
kind: Cluster
metadata:
  finalizers:
    - cluster.kubeblocks.io/finalizer
  labels:
    {{- with .Values.mongodb.labels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
    app.kubernetes.io/instance: {{ .Values.mongodb.clusterName }}
    helm.sh/chart: mongodb-cluster-0.9.1
    sealaf-app: {{ .Release.Name }}
  annotations: {}
  name: {{ .Values.mongodb.clusterName }}
  namespace: {{ .Release.Namespace }}
spec:
  affinity:
    {{- toYaml .Values.mongodb.affinity | nindent 4 }}
  componentSpecs:
    - componentDef: mongodb
      monitor: {{ .Values.mongodb.monitor }}
      name: {{ .Values.mongodb.componentName }}
      replicas: {{ .Values.mongodb.replicas }}
      resources:
        {{- toYaml .Values.mongodb.resources | nindent 8 }}
      serviceAccountName: {{ .Values.mongodb.serviceAccountName }}
      serviceVersion: {{ .Values.mongodb.serviceVersion }}
      volumeClaimTemplates:
        - name: {{ .Values.mongodb.storage.name }}
          spec:
            accessModes:
              {{- toYaml .Values.mongodb.storage.accessModes | nindent 14 }}
            resources:
              requests:
                storage: {{ .Values.mongodb.storage.size }}
  terminationPolicy: {{ .Values.mongodb.terminationPolicy }}
{{- end }}
