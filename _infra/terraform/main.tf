module "nf_service" {
  source       = "spacelift.io/netlify/aws-nf-service/default"
  version      = "0.6.0"
  service_name = local.service_name
  account_name = local.account_name
  region_name  = var.region_name
  environment  = var.environment
  tags         = var.tags
}
