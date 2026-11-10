# AWS cell foundation

Implements the foundation in [#2480](https://github.com/kodustech/kodus-ai/issues/2480#issuecomment-6720634241). This module creates **no EC2 instances, image bake, proxy attachment, bootstrap scripts, Lambda, schedule or working cell**. `foundation_only = true` and `data_plane_routes_ready = false` are deliberate output contracts.

Validated locally with OpenTofu **1.13.9**, compatible configuration floor **1.9.0**, and AWS provider **6.72.0** exactly, recorded in `.terraform.lock.hcl`. This is a child module: provider identity and a separate encrypted/locked remote state backend belong in the caller. Never use production's VPC/account/state. No secrets are inputs or outputs; Terraform state still contains infrastructure identifiers and IAM policies.

## Boundaries

| Resource | Configuration |
|---|---|
| Network | Dedicated RFC1918 IPv4 /20, four /24 subnets in one AZ; no IPv6, peering or inbound internet rules |
| Egress | IGW/NAT in egress subnet; only **cell** has a NAT default route. Workload and observer have local routing only. NAT/endpoints/DNS Firewall incur baseline AWS charges after a future apply. |
| Control | Agent can use HTTPS, SSH22 to workload and API7443 to observer. Runtime creates per-claim ingress from the agent SG. Proxy control8443 accepts agent SG only; the process must independently enforce mTLS. |
| Data | Proxy SG permits HTTP80/443 and TCP/UDP53 from workload/observer private CIDRs only. No proxy host/ENI or route is created. |
| AWS endpoints | EC2/KMS/STS interfaces only in cell subnet; SG443 only from agent; endpoint policies restrict the principal to the cell role. S3 gateway attaches only to the cell route table and evidence buckets. Endpoint policy does not grant actions missing from IAM. |
| DNS | VPC-wide native DNS Firewall allows exact configured control-plane and regional AWS names, checks redirection targets, then blocks `*` with NXDOMAIN; fail-open disabled. Egress resolver upstream53 is disabled unless explicit /32 addresses are provided. |
| Evidence | One private bucket and rotating KMS key per organization; enforced bucket ownership, KMS default encryption with denies for explicit AES256/wrong or missing organization KMS key headers, TLS-only, 30-day expiration, incomplete uploads removed after one day; no force_destroy. |
| Workload template | Approved AMI ID, encrypted gp3, IMDS disabled; no NIC/profile/user-data; subnet auto-public-IP and VPC IPv6 disabled. No template NIC: current driver supplies top-level SubnetId/SecurityGroupIds, which conflict with template network_interfaces. Default root device is `/dev/xvda`: image pipeline must verify that device against every approved AMI. Runtime overrides subnet/claim SG/organization KMS. |
| IAM | Current driver and reaper JSON templates are reused; image wildcard is replaced with the explicit AMI catalog. Reaper role is dormant and only describes/terminates this cell. Runtime has no PassRole. |

AWS security groups **cannot block AmazonProvidedDNS**, including VPC+2. The native firewall closes arbitrary DNS names but is shared across the whole VPC: the allowed control-plane DNS names remain resolvable by a workload directly querying AmazonProvidedDNS, bypassing the custom resolver. This is **not per-claim DNS enforcement or proof of zero exfiltration**. A later networking gate must test direct DNS, subdomain matches, CNAME chains, DNS64/IPv6, DoH and public-IP attempts. Control-plane CNAME targets must be explicitly added; there is no wildcard escape hatch.

Organization keys are separate, but the cell role can use the declared set of keys. IAM here **does not prove dynamic claim→org key isolation**. The driver/pool validation and a future per-claim credential boundary must enforce that association. Evidence grants similarly constrain org prefixes but do not mint side-specific credentials. `aws_config` contains public resource identifiers compatible with `cmd/cell`'s `awsConfig`; do not treat it as a readiness signal.

## Offline verification

Use a private CLI/cache location. `init` downloads the pinned provider and checks its signed checksums; `validate` and `test` use provider schemas/mocks. Tests intentionally contain `command = apply` only to materialize **mock resources**, never AWS resources. No AWS credentials or provider API calls are required.

```sh
export TF_DATA_DIR=/private/tmp/kody-runtime-next/iac-data
/private/tmp/kody-runtime-next/tooling/tofu -chdir=apps/runtime-cell/deploy/opentofu/aws-cell init -backend=false -input=false
/private/tmp/kody-runtime-next/tooling/tofu -chdir=apps/runtime-cell/deploy/opentofu/aws-cell fmt -check -recursive
/private/tmp/kody-runtime-next/tooling/tofu -chdir=apps/runtime-cell/deploy/opentofu/aws-cell validate
/private/tmp/kody-runtime-next/tooling/tofu -chdir=apps/runtime-cell/deploy/opentofu/aws-cell test
```

Seven native mock runs cover private topology/LT flags, account/region mismatch, wildcard DNS, unapproved images, public VPC rejection, computed storage/IAM policies and IAM inline policy size for the fixture. Mocks validate declared configuration; they do **not** prove service authorization, actual routing, TLS, AMI provenance, image reset, ready/hibernate, live performance/cost or cleanup.

## Gates before a dedicated-account deployment

1. Review a saved plan with the dedicated account/region, exact AMI ownership/signature/root-device checks, quotas and current driver IAM simulation. Large org/image catalogs may hit the AWS aggregate inline role-policy size limit; split cell identities before reaching it. Do not add wildcard AMIs to work around it.
2. Deploy signed cell/proxy/observer artifacts separately. Verify observer7443 TLS bootstrap (currently outside this module), proxy policy/control mTLS, source/destination-check disabled on the real proxy ENI, ENI account/VPC/subnet/cell identity and proxy/resolver readiness.
3. Only a separate reviewed attachment change may add workload/observer default routes to that **verified** proxy ENI. Never route either subnet directly to NAT/IGW. Verify route ownership and remove routes when proxy readiness fails. This module exposes no unverified `proxy_eni_id` input.
4. Deploy the independent signed reaper artifact and schedule with its dormant role. Prove hard TTL cleanup before accepting claims. No placeholder reaper counts as protection.
5. Run the live security/IAM/kill/reset/egress suite with synthetic data, including cross-org keys/pool/evidence and cross-claim observer isolation. Baseline native DNS exceptions must be tested independently of custom resolver policy.

`examples/minimal` is configuration shape only, with deliberately fake account/AMI values. It has no backend and must not be applied unchanged. Keep future state/plan artifacts outside the repository; use a separate backend/state per cell. Nothing was applied during this implementation, so no cloud rollback/state migration is required. Any future destructive change requires a reviewed destroy plan and explicit authorization.

References: [AWS SG DNS limitation](https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html), [DNS Firewall rule/redirection settings](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-dns-firewall-rule-settings.html), [provider 6.72.0](https://registry.terraform.io/providers/hashicorp/aws/6.72.0/docs).
