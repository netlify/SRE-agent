output "rds_cluster_writer_endpoint" {
  description = "Aurora writer endpoint — use this in DATABASE_URL stored in Vault"
  value       = module.nf_rds.cluster_writer_endpoint
}

output "rds_cluster_reader_endpoint" {
  description = "Aurora reader endpoint"
  value       = module.nf_rds.cluster_reader_endpoint
}

output "rds_cluster_port" {
  description = "Aurora cluster port"
  value       = module.nf_rds.cluster_port
}

output "rds_credentials_secret_id" {
  description = "AWS Secrets Manager secret ID containing the auto-generated DB master credentials"
  value       = module.nf_rds.cluster_credentials_secret_id
}

output "pod_security_group_id" {
  description = "Security group ID attached to pods — add this to argocd/applications/.../sre-agent-*.yaml SecurityGroupPolicy"
  value       = module.nf_service.pod_security_group_id
}

output "pod_iam_role_arn" {
  description = "IAM role ARN for the pod service account (IRSA) — add this to the sre-agent-default ServiceAccount annotation"
  value       = module.nf_service.pod_iam_role_arn
}
