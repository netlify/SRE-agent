variable "spacelift_run_id" {}

variable "environment" {
  description = "Environment (like `production` or `staging`)"
  type        = string
}

variable "region" {
  type        = string
  description = "AWS region where resources will be created"
}

variable "region_name" {
  type        = string
  description = "Netlify airport code name for the AWS region (e.g. cmh)"
}

variable "tags" {
  description = "Tags to be set at the resource/module level"
  type        = map(string)
}

variable "default_tags" {
  description = "Tags to be set at the provider level"
  default     = {}
  type        = map(string)
}

variable "rds_instance_type" {
  type        = string
  description = "Aurora cluster instance type (db.t4g.medium for staging, db.t4g.large for production)"
}

variable "engine" {
  type        = string
  description = "RDS cluster engine type"
  default     = "aurora-postgresql"
}

variable "engine_version" {
  type        = string
  description = "Aurora PostgreSQL engine version"
  default     = "16.4"
}

variable "family" {
  type        = string
  description = "Aurora PostgreSQL parameter group family"
  default     = "aurora-postgresql16"
}

variable "cluster_parameters" {
  description = "Cluster-level Aurora parameters"
  type = list(object({
    name         = string
    value        = string
    apply_method = string
  }))
  default = [
    # Required non-empty default for postgres — the module's built-in mysql defaults
    # are not valid for postgres clusters, so at least one param must be specified.
    {
      name         = "auto_explain.log_analyze"
      value        = "1"
      apply_method = "immediate"
    },
  ]
}

variable "instance_parameters" {
  description = "Instance-level Aurora parameters"
  type = list(object({
    name         = string
    value        = string
    apply_method = string
  }))
  default = []
}
