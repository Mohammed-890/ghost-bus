{{- define "gb.fullname" -}}{{ .Release.Name | trunc 40 | trimSuffix "-" }}{{- end -}}

{{- define "gb.labels" -}}
app.kubernetes.io/name: ghost-bus
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "gb.selector" -}}
app.kubernetes.io/name: ghost-bus
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "gb.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "gb.mlflowImage" -}}{{ .Values.mlflowImage.repository }}:{{ .Values.mlflowImage.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "gb.mlflowHost" -}}{{ include "gb.fullname" . }}-mlflow{{- end -}}

{{/* Shared container settings: env from the ConfigMap, tmp dir, security. */}}
{{- define "gb.common" -}}
image: {{ include "gb.image" . }}
imagePullPolicy: {{ .Values.image.pullPolicy }}
envFrom:
  - configMapRef:
      name: {{ include "gb.fullname" . }}-config
securityContext:
  {{- toYaml .Values.securityContext | nindent 2 }}
{{- end -}}

{{- define "gb.bodsEnv" -}}
{{- if .Values.bods.existingSecret }}
- name: BODS_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.bods.existingSecret }}
      key: {{ .Values.bods.secretKey }}
{{- end }}
{{- end -}}
