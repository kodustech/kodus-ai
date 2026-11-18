package agent

import (
	"maps"
	"regexp"
	"slices"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The org's secrets on a claim (docs/runtime/sandbox.md "Secrets: OpenBao").
// claim.acquire and sandbox.acquire name them by reference (id, name, hosts;
// never a value). The cell gives each a new placeholder per claim
// (policy.NewPlaceholder) and:
//   - exposes it to the machines as the env var named after the secret: every
//     compose service's environment (Run sides and setups), every sandbox
//     exec's env;
//   - signs it into the claim's egress policy (ClaimInfo.OrgSecrets ->
//     policy.Spec.Secrets), so the injector swaps it for the value it reads
//     from the store on requests to the secret's hosts, and only those.
//
// Naming and collisions. The env var is the secret's name (upper snake case;
// the id is the name in lower case, so two secrets of an org never share
// one). A name the machine's own tooling owns (PATH, HOME, the proxy and TLS
// variables, the trust variables the cell sets, LD_*, KODUS_*, KODY_*,
// RUNTIME_*, as the API refuses them) is dropped here too. In a compose service the secret's value replaces what the
// compose file or the recipe set under the same name (the admin bound the
// name to the secret), and the canary decoy env is set after it (its name is
// reserved anyway). In a sandbox exec the caller's own env wins over a secret
// of the same name: the caller is Kodus, naming that variable for that
// command.
//
// A secret whose every host the platform denies is dropped and reported, as
// policy.Build drops a denied host: its placeholder would go nowhere.

var orgSecretName = regexp.MustCompile(protocol.RuntimeSecretNamePattern)

// reservedSecretNames are the API's (libs/runtime/api/domain/secrets.ts,
// generated into protocol).
var reservedSecretNames = func() map[string]bool {
	out := make(map[string]bool, len(protocol.ReservedSecretNames))
	for _, n := range protocol.ReservedSecretNames {
		out[n] = true
	}
	return out
}()

// secretNameRefused says why a secret's name cannot be an env var of the
// claim's machines, or "".
func secretNameRefused(name string) string {
	if !orgSecretName.MatchString(name) {
		return "name"
	}
	// The trust variables too: the cell points them at its CA bundle in the
	// machines of a claim with secrets (machinetrust.EnvNames).
	if reservedSecretNames[name] || machinetrust.IsEnvName(name) {
		return "reserved_name"
	}
	for _, p := range protocol.ReservedSecretPrefixes {
		if strings.HasPrefix(name, p) {
			return "reserved_name"
		}
	}
	return ""
}

// orgSecretsFor gives each secret of the acquire a new placeholder, keeping
// only the hosts the platform allows. It returns the ids it dropped, with
// why, for the claim's log.
func (a *Agent) orgSecretsFor(acq protocol.ClaimAcquireBody) ([]claims.OrgSecret, map[string]string, error) {
	if len(acq.Secrets) == 0 {
		return nil, nil, nil
	}
	dropped := map[string]string{}
	var out []claims.OrgSecret
	for _, s := range acq.Secrets {
		if why := secretNameRefused(s.Name); why != "" {
			dropped[s.ID] = why
			continue
		}
		if !policy.ValidSecretID(s.ID) {
			dropped[s.ID] = "id"
			continue
		}
		var hosts []string
		for _, h := range s.Hosts {
			n, err := policy.NormalizeHost(h)
			if err != nil || strings.Contains(h, "*") {
				continue
			}
			if a.cfg.SecretHostDenied != nil && a.cfg.SecretHostDenied(n) {
				continue
			}
			hosts = append(hosts, n)
		}
		if len(hosts) == 0 {
			dropped[s.ID] = "hosts_denied"
			continue
		}
		ph, err := policy.NewPlaceholder()
		if err != nil {
			return nil, nil, err
		}
		slices.Sort(hosts)
		out = append(out, claims.OrgSecret{Name: s.Name, Secret: policy.Secret{ID: s.ID, Placeholder: ph, Hosts: slices.Compact(hosts)}})
	}
	return out, dropped, nil
}

// needsCellTrust: the claim's machines must trust the cell CA, the one the
// injector terminates a secret's requests with, and an inspected host's
// (Config.InspectEgress).
func (a *Agent) needsCellTrust(c *claims.Claim) bool {
	return len(c.OrgSecrets) > 0 || a.cfg.InspectEgress
}

// cellTrustFor is whether a boot of the claim's machines asks the driver
// for the cell CA (UpRequest.CellTrust, SandboxRequest.CellTrust): when
// they need it and the driver mounts the trust files for this kind of
// machine (mounts). It records on the claim that they have it.
func (a *Agent) cellTrustFor(c *claims.Claim, mounts bool) bool {
	trust := mounts && a.needsCellTrust(c)
	if trust {
		c.MarkCellTrusted()
	}
	return trust
}

// sandboxRequest is the claim's sandbox of spec. Its machine asks the cell
// CA only from a driver whose sandboxes take the trust files
// (Capabilities.SandboxCellTrust): one without makes it as it is, and the
// claim is not counted trusted, so its TLS to an inspected host stays SNI
// passthrough instead of failing on a CA it never got.
func (a *Agent) sandboxRequest(c *claims.Claim, spec driver.MachineSpec) driver.SandboxRequest {
	mounts := a.cfg.CellTrust && a.cfg.Driver.Capabilities().SandboxCellTrust
	return driver.SandboxRequest{Spec: spec, CellTrust: a.cellTrustFor(c, mounts)}
}

// policySecrets are the claim's secrets as its signed policy carries them.
func policySecrets(c *claims.Claim) []policy.Secret {
	if len(c.OrgSecrets) == 0 {
		return nil
	}
	out := make([]policy.Secret, 0, len(c.OrgSecrets))
	for _, s := range c.OrgSecrets {
		out = append(out, s.Secret)
	}
	return out
}

// secretEnv is the env the claim's machines get: each secret's placeholder
// under its name; nil without secrets.
func secretEnv(c *claims.Claim) map[string]string {
	if len(c.OrgSecrets) == 0 {
		return nil
	}
	out := make(map[string]string, len(c.OrgSecrets))
	for _, s := range c.OrgSecrets {
		out[s.Name] = s.Placeholder
	}
	return out
}

// secretEnvFor is a sandbox exec's env: the caller's, plus each secret's
// placeholder the caller did not name itself.
func secretEnvFor(c *claims.Claim, op protocol.SandboxOp) protocol.SandboxOp {
	env := secretEnv(c)
	if op.Op != protocol.SandboxOpKindExec || len(env) == 0 {
		return op
	}
	merged := maps.Clone(env)
	maps.Copy(merged, op.Env)
	op.Env = merged
	return op
}
