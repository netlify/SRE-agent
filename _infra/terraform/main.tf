module "nf_service" {
  source       = "spacelift.io/netlify/aws-nf-service/default"
  version      = "0.6.0"
  service_name = local.service_name
  account_name = local.account_name
  region_name  = var.region_name
  environment  = var.environment
  tags         = var.tags
}

module "nf_rds" {
  source              = "spacelift.io/netlify/aws-nf-rds/default"
  version             = "3.3.1"
  service_name        = local.service_name
  account_name        = local.account_name
  region_name         = var.region_name
  environment         = var.environment
  tags                = var.tags
  instance_type       = var.rds_instance_type
  engine              = var.engine
  engine_version      = var.engine_version
  family              = var.family
  cluster_parameters  = var.cluster_parameters
  instance_parameters = var.instance_parameters
  ingress_security_groups = [
    module.nf_service.pod_security_group_id,
  ]
}
