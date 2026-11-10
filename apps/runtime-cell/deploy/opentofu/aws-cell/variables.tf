variable "cell_id" {
  description = "Stable cell identity used in IAM conditions and resource names."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.cell_id))
    error_message = "Use 3–31 lowercase letters, digits or hyphens, starting with a letter."
  }
}
variable "expected_account_id" {
  description = "Dedicated Runtime account; mismatches stop planning."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Expected a twelve-digit AWS account ID."
  }
}
variable "region" {
  description = "Commercial AWS region, checked against the caller provider."
  type        = string
  validation {
    condition     = can(regex("^(us|eu|ap|ca|sa|af|me|il|mx)-[a-z]+-[0-9]$", var.region))
    error_message = "Use an explicit commercial AWS region."
  }
}
variable "availability_zone" {
  description = "One AZ in the selected region; a cell is intentionally a single-AZ failure domain."
  type        = string
  validation {
    condition     = startswith(var.availability_zone, var.region) && can(regex("[a-z]$", var.availability_zone))
    error_message = "Availability zone must belong to region."
  }
}
variable "vpc_cidr" {
  description = "Dedicated RFC1918 IPv4 /20 VPC; the first four /24 subnets are reserved."
  type        = string
  default     = "10.80.0.0/20"
  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && can(regex("/20$", var.vpc_cidr)) && (can(regex("^10\\.", var.vpc_cidr)) || can(regex("^192\\.168\\.", var.vpc_cidr)) || can(regex("^172\\.(1[6-9]|2[0-9]|3[01])\\.", var.vpc_cidr)))
    error_message = "Use a private RFC1918 IPv4 /20."
  }
}
variable "organizations" {
  description = "Organization IDs receiving separate KMS keys and evidence buckets."
  type        = set(string)
  validation {
    condition     = length(var.organizations) > 0 && alltrue([for id in var.organizations : can(regex("^[a-z0-9][a-z0-9-]{1,35}$", id)) && length("kodus-${var.expected_account_id}-${var.cell_id}-${id}") <= 63])
    error_message = "Supply stable lowercase organization IDs (2–36 chars), keeping generated bucket names within 63 chars."
  }
}
variable "default_organization" {
  description = "Org key used by the template default root disk. Runtime must override it for every claim using orgKeys."
  type        = string
  validation {
    condition     = contains(var.organizations, var.default_organization)
    error_message = "Default organization must be in organizations."
  }
}
variable "approved_ami_ids" {
  description = "Explicit AMI catalog owned by this account, approved by the image pipeline. No discovery by name."
  type        = set(string)
  validation {
    condition     = length(var.approved_ami_ids) > 0 && alltrue([for id in var.approved_ami_ids : can(regex("^ami-[0-9a-f]{17}$", id))])
    error_message = "Supply explicit long-form AMI IDs."
  }
}
variable "workload_ami_id" {
  description = "Approved workload base AMI; this module does not bake or attest it."
  type        = string
  validation {
    condition     = contains(var.approved_ami_ids, var.workload_ami_id)
    error_message = "Workload AMI must be in the approved catalog."
  }
}
variable "observer_ami_id" {
  description = "Approved observer AMI; this module does not bake or attest it."
  type        = string
  validation {
    condition     = contains(var.approved_ami_ids, var.observer_ami_id)
    error_message = "Observer AMI must be in the approved catalog."
  }
}
variable "control_plane_hosts" {
  description = "Exact external control-plane/Git hosts permitted through AmazonProvidedDNS. No wildcard, URL, trailing dot or IP literal."
  type        = set(string)
  validation {
    condition     = length(var.control_plane_hosts) > 0 && alltrue([for host in var.control_plane_hosts : length(host) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]([a-z0-9-]*[a-z0-9])?$", host))])
    error_message = "Only exact lowercase DNS hostnames are accepted."
  }
}
variable "upstream_dns_ipv4" {
  description = "Explicit upstream DNS IPv4 /32 CIDRs used only by the egress resolver. Empty disables external DNS forwarding."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for cidr in var.upstream_dns_ipv4 : can(cidrnetmask(cidr)) && can(regex("/32$", cidr))])
    error_message = "DNS upstream entries must be individual IPv4 /32 CIDRs."
  }
}
variable "root_volume_gb" {
  description = "Template gp3 root volume size; runtime may request a larger disk."
  type        = number
  default     = 100
  validation {
    condition     = var.root_volume_gb >= 20 && var.root_volume_gb <= 1024 && floor(var.root_volume_gb) == var.root_volume_gb
    error_message = "Root disk must be an integer from 20 to 1024 GiB."
  }
}
variable "tags" {
  description = "Additional non-secret tags. Security identity tags are always set by the module."
  type        = map(string)
  default     = {}
}
