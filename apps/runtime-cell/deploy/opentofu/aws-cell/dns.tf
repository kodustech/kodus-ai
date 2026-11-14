# Security groups cannot filter AmazonProvidedDNS. Do not substitute SG rules for this firewall.
resource "aws_route53_resolver_firewall_domain_list" "control" {
  name    = "${var.cell_id}-exact-control-hosts"
  domains = sort(tolist(setunion(var.control_plane_hosts, toset(local.regional_hosts), toset([for org in var.organizations : "kodus-${var.expected_account_id}-${var.cell_id}-${org}.s3.${var.region}.amazonaws.com"]))))
  tags    = local.tags
}
resource "aws_route53_resolver_firewall_domain_list" "remaining" {
  name    = "${var.cell_id}-deny-remaining"
  domains = ["*"]
  tags    = local.tags
}
resource "aws_route53_resolver_firewall_rule_group" "cell" {
  name = "${var.cell_id}-dns-boundary"
  tags = local.tags
}
resource "aws_route53_resolver_firewall_rule" "control" {
  name                               = "exact-control-hosts"
  action                             = "ALLOW"
  firewall_domain_list_id            = aws_route53_resolver_firewall_domain_list.control.id
  firewall_rule_group_id             = aws_route53_resolver_firewall_rule_group.cell.id
  firewall_domain_redirection_action = "INSPECT_REDIRECTION_DOMAIN"
  priority                           = 100
}
resource "aws_route53_resolver_firewall_rule" "deny_remaining" {
  name                    = "deny-remaining"
  action                  = "BLOCK"
  block_response          = "NXDOMAIN"
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.remaining.id
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.cell.id
  priority                = 200
}
resource "aws_route53_resolver_firewall_rule_group_association" "cell" {
  name                   = "${var.cell_id}-dns-boundary"
  firewall_rule_group_id = aws_route53_resolver_firewall_rule_group.cell.id
  priority               = 100
  vpc_id                 = aws_vpc.cell.id
  mutation_protection    = "ENABLED"
  tags                   = local.tags
}
resource "aws_route53_resolver_firewall_config" "cell" {
  resource_id        = aws_vpc.cell.id
  firewall_fail_open = "DISABLED"
}
