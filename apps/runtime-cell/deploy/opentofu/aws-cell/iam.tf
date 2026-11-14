locals {
  iam_parameters = {
    Region           = var.region, Account = var.expected_account_id, CellId = var.cell_id,
    LaunchTemplateId = aws_launch_template.workload.id,
    WorkloadSubnetId = aws_subnet.cell["workload"].id,
    ObserverSubnetId = aws_subnet.cell["observer"].id,
    VpcId            = aws_vpc.cell.id
  }
  base_cell_policy = jsondecode(templatefile("${path.module}/../../../internal/drivers/awsec2/iam/cell-role.json", local.iam_parameters))
  # Reuse the audited driver policy; replace its broad image selector with the explicit approved catalog.
  cell_statements = [for statement in local.base_cell_policy.Statement : merge(statement, statement.Sid == "LaunchOnlyFixedImageAndSubnets" ? { Resource = concat([for id in var.approved_ami_ids : "arn:aws:ec2:${var.region}::image/${id}"], [for arn in statement.Resource : arn if !strcontains(arn, ":image/")]) } : {})]
  organization_kms_statements = flatten([for org in var.organizations : [
    { Sid = "EvidenceKey${substr(sha256(org), 0, 16)}", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = aws_kms_key.organization[org].arn, Condition = { StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" }, StringLike = { "kms:EncryptionContext:aws:s3:arn" = [aws_s3_bucket.evidence[org].arn, "${aws_s3_bucket.evidence[org].arn}/*"] } } },
    { Sid = "DiskKey${substr(sha256(org), 0, 16)}", Effect = "Allow", Action = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKeyWithoutPlaintext", "kms:DescribeKey", "kms:ReEncrypt*"], Resource = aws_kms_key.organization[org].arn, Condition = { StringEquals = { "kms:ViaService" = "ec2.${var.region}.amazonaws.com", "kms:CallerAccount" = var.expected_account_id } } },
    { Sid = "DiskGrant${substr(sha256(org), 0, 16)}", Effect = "Allow", Action = "kms:CreateGrant", Resource = aws_kms_key.organization[org].arn, Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" }, StringEquals = { "kms:ViaService" = "ec2.${var.region}.amazonaws.com" } } }
  ]])
  cell_policy = jsonencode({ Version = "2012-10-17", Statement = concat(local.cell_statements, local.organization_kms_statements, [
    { Sid = "ApprovedImageCatalog", Effect = "Allow", Action = ["ec2:DescribeImages", "ec2:DescribeVolumes"], Resource = "*" },
    { Sid = "EvidenceBuckets", Effect = "Allow", Action = ["s3:ListBucket"], Resource = [for bucket in aws_s3_bucket.evidence : bucket.arn] },
    { Sid = "EvidenceObjects", Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = [for org in var.organizations : "${aws_s3_bucket.evidence[org].arn}/${org}/*"] }
  ]) })
}
resource "aws_iam_role" "cell" {
  name               = "${var.cell_id}-agent"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags               = local.tags
}
resource "aws_iam_instance_profile" "cell" {
  name = "${var.cell_id}-agent"
  role = aws_iam_role.cell.name
  tags = local.tags
}
resource "aws_iam_role_policy" "cell" {
  name   = "runtime-driver-and-evidence"
  role   = aws_iam_role.cell.id
  policy = local.cell_policy
}
# Dormant identity only: deployment of a verified reaper artifact/schedule is a separate gate.
resource "aws_iam_role" "reaper" {
  name               = "${var.cell_id}-reaper"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags               = local.tags
}
resource "aws_iam_role_policy" "reaper" {
  name   = "expire-only-this-cell"
  role   = aws_iam_role.reaper.id
  policy = templatefile("${path.module}/../../../internal/drivers/awsec2/iam/reaper-role.json", local.iam_parameters)
}
