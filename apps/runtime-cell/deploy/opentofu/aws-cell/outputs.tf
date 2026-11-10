output "foundation_only" {
  description = "Always true: no cell hosts, proxy attachment, reaper schedule or workload instances are deployed."
  value       = true
}
output "data_plane_routes_ready" {
  description = "Always false until a separate verified proxy ENI attachment adds data-plane routes."
  value       = false
}
output "aws_config" {
  description = "Secret-free cmd/cell awsConfig fields. Use only after the documented live readiness gates; runtime must set claim SG/subnet and org KMS."
  value = {
    vpcId                 = aws_vpc.cell.id
    launchTemplateId      = aws_launch_template.workload.id
    launchTemplateVersion = tostring(aws_launch_template.workload.latest_version)
    workloadSubnetId      = aws_subnet.cell["workload"].id
    observerSubnetId      = aws_subnet.cell["observer"].id
    cellAgentGroupId      = aws_security_group.cell["agent"].id
    egressGroupId         = aws_security_group.cell["egress"].id
    observerImageRef      = var.observer_ami_id
    hibernate             = false
    orgKeys               = { for org, key in aws_kms_key.organization : org => key.arn }
  }
}
output "subnet_ids" {
  description = "Four dedicated subnet IDs; no host is created."
  value       = { for name, subnet in aws_subnet.cell : name => subnet.id }
}
output "cell_instance_profile" {
  description = "Cell host profile only; never attach to workload or observer."
  value       = aws_iam_instance_profile.cell.name
}
output "reaper_role_arn" {
  description = "Dormant destroy-only role; no reaper artifact/schedule is deployed."
  value       = aws_iam_role.reaper.arn
}
output "evidence_buckets" {
  description = "Organization-scoped private evidence buckets; object prefix must start with org ID."
  value       = { for org, bucket in aws_s3_bucket.evidence : org => bucket.id }
}
