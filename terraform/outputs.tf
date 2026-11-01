output "kubeconfig_path" {
  description = "kubectl --kubeconfig <this> get pods -n ghost-bus"
  value       = kind_cluster.this.kubeconfig_path
}

output "next_steps" {
  value = <<-EOT
    API:     kubectl -n ghost-bus port-forward svc/ghost-bus-api 8000:80   -> http://localhost:8000/docs
    MLflow:  kubectl -n ghost-bus port-forward svc/ghost-bus-mlflow 5000  -> http://localhost:5000
    Grafana: kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
  EOT
}
