output "pod_security_group_id" {
  description = "Security group ID attached to pods — add this to argocd/applications/.../sre-agent-*.yaml SecurityGroupPolicy"
  value       = module.nf_service.pod_security_group_id
}

output "pod_iam_role_arn" {
  description = "IAM role ARN for the pod service account (IRSA) — add this to the sre-agent-default ServiceAccount annotation"
  value       = module.nf_service.pod_iam_role_arn
}
