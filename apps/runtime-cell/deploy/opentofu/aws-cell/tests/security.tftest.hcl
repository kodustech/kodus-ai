mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }
}
variables {
  cell_id              = "test-cell"
  expected_account_id  = "123456789012"
  region               = "us-east-1"
  availability_zone    = "us-east-1a"
  organizations        = ["test-org"]
  default_organization = "test-org"
  approved_ami_ids     = ["ami-0123456789abcdef0", "ami-0123456789abcdef1"]
  workload_ami_id      = "ami-0123456789abcdef0"
  observer_ami_id      = "ami-0123456789abcdef1"
  control_plane_hosts  = ["runtime.example.com", "api.github.com"]
}
run "private_foundation" {
  command = plan
  assert {
    condition     = !aws_vpc.cell.assign_generated_ipv6_cidr_block && length(aws_subnet.cell) == 4 && alltrue([for subnet in aws_subnet.cell : !subnet.map_public_ip_on_launch && !subnet.assign_ipv6_address_on_creation])
    error_message = "All four subnets must have no public IP assignment or IPv6."
  }
  assert {
    condition     = toset(keys(aws_route.cell_nat)) == toset(["cell"])
    error_message = "Only the cell subnet may have a NAT default route."
  }
  assert {
    condition     = aws_launch_template.workload.metadata_options[0].http_endpoint == "disabled" && length(aws_launch_template.workload.network_interfaces) == 0 && length(aws_launch_template.workload.iam_instance_profile) == 0
    error_message = "Workload template must disable metadata, public IPs and profiles."
  }
  assert {
    condition     = aws_route53_resolver_firewall_config.cell.firewall_fail_open == "DISABLED" && aws_route53_resolver_firewall_rule.deny_remaining.action == "BLOCK"
    error_message = "AmazonProvidedDNS must be deny-by-default, fail closed."
  }
  assert {
    condition     = alltrue([for value in aws_s3_bucket_public_access_block.evidence : value.block_public_acls && value.block_public_policy && value.ignore_public_acls && value.restrict_public_buckets])
    error_message = "Every organization evidence bucket must block public access."
  }
  assert {
    condition     = output.foundation_only && !output.data_plane_routes_ready
    error_message = "A foundation must not advertise an operational cell."
  }
}
run "reject_account" {
  command = plan
  variables { expected_account_id = "999999999999" }
  expect_failures = [aws_vpc.cell]
}
run "reject_wildcard_dns" {
  command = plan
  variables { control_plane_hosts = ["*.amazonaws.com"] }
  expect_failures = [var.control_plane_hosts]
}
run "reject_unapproved_image" {
  command = plan
  variables { workload_ami_id = "ami-fffffffffffffffff" }
  expect_failures = [var.workload_ami_id]
}
run "storage_and_identity" {
  # This applies only the mock graph, never cloud resources; computed policy ARNs need materialization.
  command = apply
  assert {
    condition     = alltrue([for key in aws_kms_key.organization : key.enable_key_rotation && key.deletion_window_in_days == 30])
    error_message = "Every organization key must rotate and retain a 30-day deletion window."
  }
  assert {
    condition     = alltrue(flatten([for config in aws_s3_bucket_server_side_encryption_configuration.evidence : [for rule in config.rule : rule.apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms"]]))
    error_message = "Every evidence bucket must use KMS encryption."
  }
  assert {
    condition     = alltrue(flatten([for config in aws_s3_bucket_lifecycle_configuration.evidence : [for rule in config.rule : alltrue([for expiration in rule.expiration : expiration.days == 30])]]))
    error_message = "Evidence must expire after 30 days."
  }
  assert {
    condition = alltrue([for org, policy in aws_s3_bucket_policy.evidence :
      anytrue([for statement in jsondecode(policy.policy).Statement : try(statement.Sid == "DenyExplicitNonKMSAlgorithm" && statement.Effect == "Deny" && statement.Condition.StringNotEquals["s3:x-amz-server-side-encryption"] == "aws:kms" && statement.Condition.Null["s3:x-amz-server-side-encryption"] == "false", false)]) &&
      anytrue([for statement in jsondecode(policy.policy).Statement : try(statement.Sid == "DenyExplicitKMSWithoutOrgKey" && statement.Effect == "Deny" && statement.Condition.StringEquals["s3:x-amz-server-side-encryption"] == "aws:kms" && statement.Condition.StringNotEquals["s3:x-amz-server-side-encryption-aws-kms-key-id"] == aws_kms_key.organization[org].arn, false)]) &&
      anytrue([for statement in jsondecode(policy.policy).Statement : try(statement.Sid == "DenyWrongEncryptionKey" && statement.Effect == "Deny" && statement.Condition.Null["s3:x-amz-server-side-encryption-aws-kms-key-id"] == "false" && statement.Condition.StringNotEquals["s3:x-amz-server-side-encryption-aws-kms-key-id"] == aws_kms_key.organization[org].arn, false)])
    ])
    error_message = "Explicit AES256, wrong org key, or aws:kms without the org key must not override bucket KMS defaults."
  }
  assert {
    condition     = alltrue([for mapping in aws_launch_template.workload.block_device_mappings : mapping.device_name == "/dev/xvda"])
    error_message = "Template root device must match the current Go driver mapping."
  }
  assert {
    condition     = alltrue([for policy in aws_s3_bucket_policy.evidence : anytrue([for statement in jsondecode(policy.policy).Statement : statement.Sid == "TLSOnly" && statement.Effect == "Deny" && statement.Condition.Bool["aws:SecureTransport"] == "false"])])
    error_message = "Bucket policies must deny insecure transport."
  }
  assert {
    condition     = alltrue(flatten([for mapping in aws_launch_template.workload.block_device_mappings : [for disk in mapping.ebs : disk.encrypted && disk.volume_type == "gp3" && disk.delete_on_termination]]))
    error_message = "Root disk must be encrypted gp3 and deleted with its instance."
  }
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_role_policy.cell.policy).Statement : statement.Sid == "OriginalRootCannotBeSuppliedAtLaunch" && statement.Effect == "Deny"])
    error_message = "The current immutable original-root provenance policy must survive module composition."
  }
  assert {
    condition     = alltrue(flatten([for statement in jsondecode(aws_iam_role_policy.cell.policy).Statement : statement.Sid == "LaunchOnlyFixedImageAndSubnets" ? [for arn in statement.Resource : !endswith(arn, ":image/*")] : [true]]))
    error_message = "Launch permissions must use explicit AMI catalog entries, never image/*."
  }
  assert {
    condition     = anytrue([for statement in jsondecode(aws_iam_role_policy.cell.policy).Statement : try(statement.Sid == "NoPassRoleNoProfile" && statement.Effect == "Deny" && contains(statement.Action, "iam:PassRole") && contains(statement.Action, "ec2:ModifyInstanceMetadataOptions"), false)])
    error_message = "Template composition must preserve the driver's explicit PassRole/metadata mutation deny."
  }
  assert {
    condition     = length(jsondecode(aws_iam_role_policy.reaper.policy).Statement) == 2 && jsondecode(aws_iam_role_policy.reaper.policy).Statement[1].Action == "ec2:TerminateInstances"
    error_message = "Reaper identity must remain describe plus cell-scoped termination only."
  }
  assert {
    condition     = alltrue([for host in aws_route53_resolver_firewall_domain_list.control.domains : !strcontains(host, "*")])
    error_message = "DNS allows must be exact names."
  }
  assert {
    condition     = length(aws_iam_role_policy.cell.policy) <= 10240
    error_message = "Cell inline policy exceeds the AWS aggregate inline-policy size quota; reduce catalog/orgs or split identities."
  }
}
run "reject_region" {
  command = plan
  variables {
    region            = "us-west-2"
    availability_zone = "us-west-2a"
  }
  expect_failures = [aws_vpc.cell]
}
run "reject_public_vpc" {
  command = plan
  variables { vpc_cidr = "8.8.0.0/20" }
  expect_failures = [var.vpc_cidr]
}
