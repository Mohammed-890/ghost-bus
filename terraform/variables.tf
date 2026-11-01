variable "cluster_name" {
  description = "Name of the local kind cluster."
  type        = string
  default     = "ghost-bus"
}

variable "image_tag" {
  description = "Tag of ghcr.io/mohammed-890/ghost-bus and ghost-bus-mlflow to deploy."
  type        = string
  default     = "latest-main"
}

variable "bods_api_key" {
  description = "Free Bus Open Data Service API key. Empty = no live collector."
  type        = string
  default     = ""
  sensitive   = true
}

variable "install_monitoring" {
  description = "Install kube-prometheus-stack (Prometheus, Grafana, Alertmanager) and the Ghost Bus dashboard and alerts."
  type        = bool
  default     = true
}

variable "install_argocd" {
  description = "Install Argo CD and point it at this repo (GitOps) instead of installing the chart directly."
  type        = bool
  default     = false
}
