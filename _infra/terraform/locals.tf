locals {
  service_name = "sre-agent"
  account_name = "services"
  short_env    = substr(var.environment, 0, 4)              # "production" => "prod" / "staging" => "stag"
  workspace    = "${var.region_name}-${local.short_env}"
  identifier   = "${local.service_name}-${local.workspace}" # e.g. sre-agent-cmh-prod
}
