# Configuration example only. Fake values; configure a separate encrypted/locked backend before use.
terraform {
  required_version = ">= 1.9.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.72.0"
    }
  }
}
provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = ["123456789012"]
}
module "cell_foundation" {
  source               = "../.."
  cell_id              = "runtime-example"
  expected_account_id  = "123456789012"
  region               = "us-east-1"
  availability_zone    = "us-east-1a"
  organizations        = ["example-org"]
  default_organization = "example-org"
  approved_ami_ids     = ["ami-0123456789abcdef0", "ami-0123456789abcdef1"]
  workload_ami_id      = "ami-0123456789abcdef0"
  observer_ami_id      = "ami-0123456789abcdef1"
  control_plane_hosts  = ["runtime.example.com", "api.github.com"]
}
output "foundation_only" {
  description = "This example never deploys a working cell."
  value       = module.cell_foundation.foundation_only
}
