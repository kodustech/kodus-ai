package injector

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These benchmarks measure only Go parsing and the authorized grant-ledger
// lookup path. All inputs are synthetic. They do not measure TLS, OpenBao,
// policy-signature verification, injection, process RSS, p99 or host capacity.
var secretsBenchmarkVersionSink SecretVersion
var secretsBenchmarkCredentialSink Credential

const secretsBenchmarkValue = "Bearer synthetic-benchmark-value"

func secretsBenchmarkRef() SecretVersionRef {
	return SecretVersionRef{
		Scope:   SecretScope{OrganizationID: "benchmark-org", EnvironmentID: "benchmark-env"},
		ID:      "benchmark-secret",
		Version: 3,
	}
}

// The near-cap input deliberately stresses optional-envelope traversal. It is
// not a typical KV response or a claim about production request distribution.
// Allocation of the input buffer is excluded from the measured decode loop.
func secretsBenchmarkEnvelope(b *testing.B, nearCap bool) []byte {
	b.Helper()
	normal := `{"request_id":"synthetic-benchmark-request","data":{"data":{"organizationId":"benchmark-org","environmentId":"benchmark-env","secretId":"benchmark-secret","value":"Bearer synthetic-benchmark-value","expiresAt":"2030-01-01T02:00:00Z"},"metadata":{"version":3,"destroyed":false,"deletion_time":"","created_time":"2029-12-31T00:00:00Z","custom_metadata":null}}}`
	if !nearCap {
		return []byte(normal)
	}
	const entry = `{"label":"synthetic-unused","values":[1,2,3],"enabled":true}`
	const end = `],"padding":"` + `"}}`
	target := maxOpenBaoResponse - 1024
	var out strings.Builder
	out.Grow(target)
	out.WriteString(strings.TrimSuffix(normal, "}"))
	out.WriteString(`,"unusedEnvelope":{"entries":[`)
	entries := (target - out.Len() - len(end)) / (len(entry) + 1)
	if entries < 1 {
		b.Fatal("near-cap fixture cannot fit its unused entries")
	}
	for i := range entries {
		if i > 0 {
			out.WriteByte(',')
		}
		out.WriteString(entry)
	}
	out.WriteString(`],"padding":"`)
	out.WriteString(strings.Repeat("x", target-out.Len()-len(`"}}`)))
	out.WriteString(`"}}`)
	if out.Len() != target {
		b.Fatal("near-cap fixture does not match its bounded target size")
	}
	return []byte(out.String())
}

// BenchmarkDecodeOpenBaoVersion includes strict JSON traversal, pinned
// identity/version/expiry validation and returned SecretVersion allocation.
// SetBytes reports JSON input throughput, not backend/network throughput.
func BenchmarkDecodeOpenBaoVersion(b *testing.B) {
	for _, size := range []struct {
		name    string
		nearCap bool
	}{{"normal", false}, {"near_cap_unused_envelope", true}} {
		b.Run(size.name, func(b *testing.B) {
			b.StopTimer()
			raw := secretsBenchmarkEnvelope(b, size.nearCap)
			ref := secretsBenchmarkRef()
			value, err := decodeOpenBaoVersion(raw, ref)
			if err != nil || value.Value != secretsBenchmarkValue || value.Scope != ref.Scope || value.Version != ref.Version {
				b.Fatal("synthetic decode fixture was not accepted")
			}
			b.SetBytes(int64(len(raw)))
			b.ReportAllocs()
			b.ResetTimer()
			b.StartTimer()
			for range b.N {
				value, err := decodeOpenBaoVersion(raw, ref)
				if err != nil {
					b.Fatal("synthetic decode failed")
				}
				secretsBenchmarkVersionSink = value
			}
			b.StopTimer()
		})
	}
}

type secretsBenchmarkReader struct{ value SecretVersion }

func (r secretsBenchmarkReader) ReadVersion(ctx context.Context, ref SecretVersionRef) (SecretVersion, error) {
	if err := ctx.Err(); err != nil {
		return SecretVersion{}, err
	}
	if ref.Scope != r.value.Scope || ref.ID != r.value.ID || ref.Version != r.value.Version {
		return SecretVersion{}, ErrVaultDenied
	}
	return r.value, nil
}

type secretsBenchmarkAuthority struct{ authority ClaimAuthority }

func (a secretsBenchmarkAuthority) AuthorizeBinding(ctx context.Context, binding Binding) (ClaimAuthority, error) {
	if err := ctx.Err(); err != nil {
		return ClaimAuthority{}, err
	}
	if binding.Scope != a.authority.Scope || binding.Host != "api.example.test" || binding.ExpiresAt.After(a.authority.ExpiresAt) {
		return ClaimAuthority{}, ErrVaultDenied
	}
	return a.authority, nil
}

func secretsBenchmarkExternalGrant(b *testing.B, withBaits bool) (ManagedVault, Binding) {
	b.Helper()
	base, err := filepath.EvalSymlinks(b.TempDir())
	if err != nil {
		b.Fatal("benchmark private directory was not canonical")
	}
	dir := filepath.Join(base, "metadata")
	if err = os.Mkdir(dir, 0700); err != nil {
		b.Fatal("benchmark private metadata directory could not be created")
	}
	key := filepath.Join(base, "synthetic.key")
	if err = os.WriteFile(key, bytes.Repeat([]byte{7}, 32), 0600); err != nil {
		b.Fatal("benchmark synthetic key could not be created")
	}
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	ref := secretsBenchmarkRef()
	value := SecretVersion{Scope: ref.Scope, ID: ref.ID, Version: ref.Version, Value: secretsBenchmarkValue, ExpiresAt: now.Add(2 * time.Hour)}
	binding := Binding{
		Scope:     ClaimScope{SecretScope: ref.Scope, ClaimID: "benchmark-claim"},
		SecretID:  ref.ID,
		Version:   ref.Version,
		Host:      "api.example.test",
		Header:    "Authorization",
		ExpiresAt: now.Add(30 * time.Minute),
	}
	if withBaits {
		binding.Baits = []string{"synthetic-benchmark-bait-one", "synthetic-benchmark-bait-two"}
	}
	vault, err := OpenConfiguredVault(VaultConfig{
		Directory: dir, KeyFile: key, CellID: "benchmark-cell",
		Claims: secretsBenchmarkAuthority{ClaimAuthority{
			Scope: binding.Scope, ExpiresAt: now.Add(time.Hour), CredentialHosts: []string{binding.Host},
		}},
		ExternalValues:   secretsBenchmarkReader{value},
		ExternalSourceID: "benchmark-owner-profile",
		Now:              func() time.Time { return now },
	})
	if err != nil {
		b.Fatal("benchmark external metadata ledger could not be opened")
	}
	b.Cleanup(func() { _ = vault.Close() })
	ctx := context.Background()
	if err = vault.RegisterExternalVersion(ctx, ExternalSecretVersion{Scope: ref.Scope, ID: ref.ID, Version: ref.Version, ExpiresAt: value.ExpiresAt}); err != nil {
		b.Fatal("benchmark external version registration failed")
	}
	if err = vault.Bind(ctx, binding); err != nil {
		b.Fatal("benchmark authorized grant setup failed")
	}
	return vault, binding
}

// BenchmarkCredentialAuthorizedExternal measures the real ledger's permitted
// Credential path, including normalization, authorization rechecks, gate/map
// lookups, exact external identity/value/expiry checks and defensive bait copies.
// The external reader and authority are immutable in-memory fixtures: there is
// no network, backend cache, signed policy store, mutation or fsync in the timed
// region. Ledger creation, registration, binding, warm-up and Close are outside
// that region. These sequential timings are not contention or capacity tests.
func BenchmarkCredentialAuthorizedExternal(b *testing.B) {
	for _, fixture := range []struct {
		name      string
		withBaits bool
	}{{"no_baits", false}, {"two_baits", true}} {
		b.Run(fixture.name, func(b *testing.B) {
			b.StopTimer()
			vault, binding := secretsBenchmarkExternalGrant(b, fixture.withBaits)
			ctx := context.Background()
			warm, err := vault.Credential(ctx, binding.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host)
			if err != nil || warm.Value != secretsBenchmarkValue || warm.Header != binding.Header || !warm.ExpiresAt.Equal(binding.ExpiresAt) || len(warm.Baits) != len(binding.Baits) {
				b.Fatal("benchmark authorized lookup fixture was not accepted")
			}
			b.ReportAllocs()
			b.ResetTimer()
			b.StartTimer()
			for range b.N {
				credential, err := vault.Credential(ctx, binding.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host)
				if err != nil {
					b.Fatal("benchmark authorized lookup failed")
				}
				secretsBenchmarkCredentialSink = credential
			}
			b.StopTimer()
		})
	}
}
