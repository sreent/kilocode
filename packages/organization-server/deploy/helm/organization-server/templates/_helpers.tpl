{{- define "organization-server.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "organization-server.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "organization-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "organization-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "organization-server.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "organization-server.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* "true" with a PostgreSQL server, empty with the embedded database. */}}
{{- define "organization-server.external" -}}
{{- if or .Values.database.url .Values.database.existingSecret }}true{{ end }}
{{- end }}

{{/* Whether the chart keeps a Secret of its own, for values given in values.yaml. */}}
{{- define "organization-server.secret" -}}
{{- if or (and .Values.secret.value (not .Values.secret.existingSecret)) (and .Values.database.url (not .Values.database.existingSecret)) (and .Values.bootstrap.token (not .Values.bootstrap.existingSecret)) }}true{{ end }}
{{- end }}

{{/* An environment variable read from the chart's Secret or an existing one. */}}
{{- define "organization-server.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .existing | default .fullname }}
      key: {{ ternary .key .name (ne .existing "") }}
{{- end }}
