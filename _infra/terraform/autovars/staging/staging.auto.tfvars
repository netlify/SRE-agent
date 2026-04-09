environment       = "staging"
region            = "us-east-2"
region_name       = "cmh"
rds_instance_type = "db.t4g.medium"
engine            = "aurora-postgresql"
engine_version    = "16.4"
family            = "aurora-postgresql16"

tags = {
  service     = "sre-agent"
  environment = "staging"
  managed_by  = "spacelift"
  team        = "sre"
}
