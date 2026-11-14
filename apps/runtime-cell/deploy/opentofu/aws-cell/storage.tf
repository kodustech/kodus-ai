resource "aws_kms_key" "organization" {
  for_each                = var.organizations
  description             = "Runtime ${var.cell_id} org ${each.key} disks and evidence"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = merge(local.tags, { "kodus:org" = each.key })
}
resource "aws_kms_alias" "organization" {
  for_each      = var.organizations
  name          = "alias/kodus/${var.cell_id}/${each.key}"
  target_key_id = aws_kms_key.organization[each.key].key_id
}
resource "aws_s3_bucket" "evidence" {
  for_each      = var.organizations
  bucket        = "kodus-${var.expected_account_id}-${var.cell_id}-${each.key}"
  force_destroy = false
  tags          = merge(local.tags, { "kodus:org" = each.key })
}
resource "aws_s3_bucket_public_access_block" "evidence" {
  for_each                = var.organizations
  bucket                  = aws_s3_bucket.evidence[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "evidence" {
  for_each = var.organizations
  bucket   = aws_s3_bucket.evidence[each.key].id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  for_each = var.organizations
  bucket   = aws_s3_bucket.evidence[each.key].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.organization[each.key].arn
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  for_each = var.organizations
  bucket   = aws_s3_bucket.evidence[each.key].id
  rule {
    id     = "evidence-30-days"
    status = "Enabled"
    filter {}
    expiration { days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
resource "aws_s3_bucket_policy" "evidence" {
  for_each = var.organizations
  bucket   = aws_s3_bucket.evidence[each.key].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "TLSOnly", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.evidence[each.key].arn, "${aws_s3_bucket.evidence[each.key].arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } },
    { Sid = "DenyExplicitNonKMSAlgorithm", Effect = "Deny", Principal = "*", Action = "s3:PutObject", Resource = "${aws_s3_bucket.evidence[each.key].arn}/*", Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" }, Null = { "s3:x-amz-server-side-encryption" = "false" } } },
    { Sid = "DenyExplicitKMSWithoutOrgKey", Effect = "Deny", Principal = "*", Action = "s3:PutObject", Resource = "${aws_s3_bucket.evidence[each.key].arn}/*", Condition = { StringEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" }, StringNotEquals = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.organization[each.key].arn } } },
    { Sid = "DenyWrongEncryptionKey", Effect = "Deny", Principal = "*", Action = "s3:PutObject", Resource = "${aws_s3_bucket.evidence[each.key].arn}/*", Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.organization[each.key].arn }, Null = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = "false" } } }
  ] })
}
