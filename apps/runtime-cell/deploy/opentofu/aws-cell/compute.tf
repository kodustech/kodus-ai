resource "aws_launch_template" "workload" {
  name_prefix            = "${var.cell_id}-workload-"
  image_id               = var.workload_ami_id
  update_default_version = false
  metadata_options {
    http_endpoint          = "disabled"
    http_tokens            = "required"
    http_protocol_ipv6     = "disabled"
    instance_metadata_tags = "disabled"
  }
  # Runtime supplies top-level SubnetId/SecurityGroupIds. Defining a NIC here conflicts
  # with that API shape; subnet auto-public-IP and VPC IPv6 are disabled instead.
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      encrypted             = true
      kms_key_id            = aws_kms_key.organization[var.default_organization].arn
      volume_type           = "gp3"
      volume_size           = var.root_volume_gb
      delete_on_termination = true
    }
  }
  tags = local.tags
}
