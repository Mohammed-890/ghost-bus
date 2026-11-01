# The whole platform on a local kind cluster, rebuilt with one command:
#   terraform init && terraform apply
#   terraform destroy
# Nothing here costs money; state stays on your machine (never commit it).

resource "kind_cluster" "this" {
  name           = var.cluster_name
  wait_for_ready = true
}

provider "kubernetes" {
  host                   = kind_cluster.this.endpoint
  cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
  client_certificate     = kind_cluster.this.client_certificate
  client_key             = kind_cluster.this.client_key
}

provider "helm" {
  kubernetes {
    host                   = kind_cluster.this.endpoint
    cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
    client_certificate     = kind_cluster.this.client_certificate
    client_key             = kind_cluster.this.client_key
  }
}

resource "kubernetes_namespace" "ghost_bus" {
  metadata { name = "ghost-bus" }
}

resource "kubernetes_secret" "bods" {
  count = var.bods_api_key == "" ? 0 : 1
  metadata {
    name      = "ghost-bus-bods"
    namespace = kubernetes_namespace.ghost_bus.metadata[0].name
  }
  data = { BODS_API_KEY = var.bods_api_key }
}

resource "helm_release" "monitoring" {
  count            = var.install_monitoring ? 1 : 0
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = "65.5.0"
  namespace        = "monitoring"
  create_namespace = true
  timeout          = 900
  values = [yamlencode({
    grafana = { sidecar = { dashboards = { enabled = true, label = "grafana_dashboard", searchNamespace = "ALL" } } }
    prometheus = { prometheusSpec = {
      serviceMonitorSelectorNilUsesHelmValues = false
      ruleSelectorNilUsesHelmValues           = false
    } }
  })]
}

# Option 1 (default): install the chart directly.
resource "helm_release" "ghost_bus" {
  count     = var.install_argocd ? 0 : 1
  name      = "ghost-bus"
  chart     = "${path.module}/../chart/ghost-bus"
  namespace = kubernetes_namespace.ghost_bus.metadata[0].name
  values = [yamlencode({
    image       = { tag = var.image_tag }
    mlflowImage = { tag = var.image_tag }
    bods        = { existingSecret = var.bods_api_key == "" ? "" : "ghost-bus-bods" }
    collector   = { enabled = var.bods_api_key != "" }
    pushgateway = { enabled = true }
    monitoring = {
      serviceMonitor   = var.install_monitoring
      prometheusRule   = var.install_monitoring
      grafanaDashboard = var.install_monitoring
    }
  })]
  depends_on = [helm_release.monitoring, kubernetes_secret.bods]
}

# Option 2: Argo CD syncs the chart from Git (deploy/argocd/application.yaml).
resource "helm_release" "argocd" {
  count            = var.install_argocd ? 1 : 0
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = "7.6.12"
  namespace        = "argocd"
  create_namespace = true
}

resource "kubernetes_manifest" "argocd_app" {
  count      = var.install_argocd ? 1 : 0
  manifest   = yamldecode(file("${path.module}/../deploy/argocd/application.yaml"))
  depends_on = [helm_release.argocd]
}
