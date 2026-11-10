data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
locals {
  tags           = merge(var.tags, { "kodus:cell" = var.cell_id, "kodus:managed-by" = "opentofu" })
  subnet_numbers = { egress = 0, cell = 1, observer = 2, workload = 3 }
  regional_hosts = [for service in ["ec2", "kms", "sts", "s3"] : "${service}.${var.region}.amazonaws.com"]
}
resource "aws_vpc" "cell" {
  cidr_block                       = var.vpc_cidr
  enable_dns_support               = true
  enable_dns_hostnames             = true
  assign_generated_ipv6_cidr_block = false
  tags                             = local.tags
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id && data.aws_region.current.region == var.region
      error_message = "Provider account/region must equal the explicit dedicated Runtime account/region."
    }
  }
}
resource "aws_default_security_group" "closed" {
  vpc_id = aws_vpc.cell.id
  tags   = local.tags
}
resource "aws_subnet" "cell" {
  for_each                        = local.subnet_numbers
  vpc_id                          = aws_vpc.cell.id
  availability_zone               = var.availability_zone
  cidr_block                      = cidrsubnet(var.vpc_cidr, 4, each.value)
  map_public_ip_on_launch         = false
  assign_ipv6_address_on_creation = false
  tags                            = merge(local.tags, { Name = "${var.cell_id}-${each.key}" })
}
resource "aws_route_table" "cell" {
  for_each = local.subnet_numbers
  vpc_id   = aws_vpc.cell.id
  tags     = merge(local.tags, { Name = "${var.cell_id}-${each.key}" })
}
resource "aws_route_table_association" "cell" {
  for_each       = local.subnet_numbers
  subnet_id      = aws_subnet.cell[each.key].id
  route_table_id = aws_route_table.cell[each.key].id
}
resource "aws_internet_gateway" "egress" {
  vpc_id = aws_vpc.cell.id
  tags   = local.tags
}
resource "aws_route" "egress_internet" {
  route_table_id         = aws_route_table.cell["egress"].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.egress.id
}
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = local.tags
}
resource "aws_nat_gateway" "cell" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.cell["egress"].id
  tags          = local.tags
  depends_on    = [aws_internet_gateway.egress]
}
resource "aws_route" "cell_nat" {
  for_each               = toset(["cell"])
  route_table_id         = aws_route_table.cell[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.cell.id
}
# No workload/observer default routes. A later verified proxy attachment owns those routes.
resource "aws_security_group" "cell" {
  for_each    = toset(["agent", "egress", "endpoint"])
  name_prefix = "${var.cell_id}-${each.key}-"
  description = "${each.key} fixed cell boundary; no public ingress"
  vpc_id      = aws_vpc.cell.id
  tags        = merge(local.tags, { Name = "${var.cell_id}-${each.key}" })
}
resource "aws_vpc_security_group_egress_rule" "agent_https" {
  security_group_id = aws_security_group.cell["agent"].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Control plane HTTPS via cell NAT; DNS constrained by DNS Firewall"
}
resource "aws_vpc_security_group_egress_rule" "agent_ssh" {
  security_group_id = aws_security_group.cell["agent"].id
  cidr_ipv4         = aws_subnet.cell["workload"].cidr_block
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  description       = "Runtime creates per-claim ingress accepting only the agent SG"
}
resource "aws_vpc_security_group_ingress_rule" "endpoint_https" {
  security_group_id            = aws_security_group.cell["endpoint"].id
  referenced_security_group_id = aws_security_group.cell["agent"].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}
resource "aws_vpc_security_group_ingress_rule" "proxy_control" {
  security_group_id            = aws_security_group.cell["egress"].id
  referenced_security_group_id = aws_security_group.cell["agent"].id
  ip_protocol                  = "tcp"
  from_port                    = 8443
  to_port                      = 8443
  description                  = "Proxy policy/events control; process must require mTLS"
}
resource "aws_vpc_security_group_egress_rule" "proxy_control" {
  security_group_id            = aws_security_group.cell["agent"].id
  referenced_security_group_id = aws_security_group.cell["egress"].id
  ip_protocol                  = "tcp"
  from_port                    = 8443
  to_port                      = 8443
}
locals {
  proxy_ingress = { for pair in setproduct(["workload", "observer"], ["tcp:80", "tcp:443", "tcp:53", "udp:53"]) : "${pair[0]}-${pair[1]}" => { subnet = pair[0], protocol = split(":", pair[1])[0], port = tonumber(split(":", pair[1])[1]) } }
}
resource "aws_vpc_security_group_ingress_rule" "proxy_data" {
  for_each          = local.proxy_ingress
  security_group_id = aws_security_group.cell["egress"].id
  cidr_ipv4         = aws_subnet.cell[each.value.subnet].cidr_block
  ip_protocol       = each.value.protocol
  from_port         = each.value.port
  to_port           = each.value.port
}
resource "aws_vpc_security_group_egress_rule" "proxy_web" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.cell["egress"].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  description       = "Proxy upstream transport; application allowlist remains a live readiness gate"
}
locals { dns_egress = { for pair in setproduct(var.upstream_dns_ipv4, ["tcp", "udp"]) : "${pair[0]}-${pair[1]}" => { cidr = pair[0], protocol = pair[1] } } }
resource "aws_vpc_security_group_egress_rule" "resolver_upstream" {
  for_each          = local.dns_egress
  security_group_id = aws_security_group.cell["egress"].id
  cidr_ipv4         = each.value.cidr
  ip_protocol       = each.value.protocol
  from_port         = 53
  to_port           = 53
}
resource "aws_vpc_endpoint" "control" {
  for_each            = toset(["ec2", "kms", "sts"])
  vpc_id              = aws_vpc.cell.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.cell["cell"].id]
  security_group_ids  = [aws_security_group.cell["endpoint"].id]
  private_dns_enabled = true
  policy              = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = "*", Action = "${each.key}:*", Resource = "*", Condition = { ArnEquals = { "aws:PrincipalArn" = aws_iam_role.cell.arn } } }] })
  tags                = local.tags
}
resource "aws_vpc_endpoint" "evidence" {
  vpc_id            = aws_vpc.cell.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.cell["cell"].id]
  policy            = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = "*", Action = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"], Resource = flatten([for bucket in aws_s3_bucket.evidence : [bucket.arn, "${bucket.arn}/*"]]), Condition = { ArnEquals = { "aws:PrincipalArn" = aws_iam_role.cell.arn } } }] })
  tags              = local.tags
}
resource "aws_vpc_security_group_egress_rule" "agent_observer_api" {
  security_group_id = aws_security_group.cell["agent"].id
  cidr_ipv4         = aws_subnet.cell["observer"].cidr_block
  ip_protocol       = "tcp"
  from_port         = 7443
  to_port           = 7443
  description       = "Observer API; runtime creates ingress from agent SG only, TLS bootstrap is a readiness gate"
}
