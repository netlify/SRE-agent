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
  description = "Tags to be applied to resources"
  type        = map(string)
  default     = {}
}
