package conformance

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// InjectorSecrets is the cell's credential path for a real backend: the
// target's egress hands a credential host's TLS to the cell's injector,
// which runs in the test's process on a listener the egress reaches. The
// injector shows the machine a leaf of a cell CA, swaps the claim's
// placeholder for the secret's value only toward the secret's host, and
// dials one local TLS server standing for every credential host, which
// records what each received. Nothing leaves for real but the egress's DNS
// lookup of the names, so SecretHost and NotSecretHost must resolve.
type InjectorSecrets struct {
	policies *policy.Store
	values   storedSecrets
	caPEM    string
	// push sends a claim's policy to the target's egress, as the agent does.
	push func(ctx context.Context, p policy.ClaimPolicy) error

	mu       sync.Mutex
	received map[string]string
}

type storedSecrets struct {
	mu sync.Mutex
	m  map[string]injector.StoredSecret
}

func (s *storedSecrets) Secret(_ context.Context, org, id string) (injector.StoredSecret, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.m[org+"/"+id]
	if !ok {
		return injector.StoredSecret{}, errors.New("conformance: no such secret")
	}
	return v, nil
}

// StartInjector serves the cell's injector on l until the test ends, taking
// PROXY v1 only from trustedProxies (the egress's address as l sees it).
// hosts are the credential hosts the local upstream answers for.
func StartInjector(t *testing.T, l net.Listener, trustedProxies []string, push func(context.Context, policy.ClaimPolicy) error, hosts ...string) *InjectorSecrets {
	t.Helper()
	s := &InjectorSecrets{policies: policy.NewStore(nil), values: storedSecrets{m: map[string]injector.StoredSecret{}}, push: push, received: map[string]string{}}
	cellCA, err := testpki.NewCA("conformance cell CA")
	if err != nil {
		t.Fatal(err)
	}
	upstreamCA, err := testpki.NewCA("conformance upstream CA")
	if err != nil {
		t.Fatal(err)
	}
	upCert, err := upstreamCA.Issue("upstream", time.Hour, hosts...)
	if err != nil {
		t.Fatal(err)
	}
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.received[r.Host] = r.Header.Get("Authorization")
		s.mu.Unlock()
		_, _ = w.Write([]byte("ok"))
	}))
	up.TLS = &tls.Config{Certificates: []tls.Certificate{upCert}, MinVersion: tls.VersionTLS12}
	up.StartTLS()
	t.Cleanup(up.Close)
	s.caPEM = string(cellCA.PEM)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	inj := &injector.Injector{
		Policies: s.policies, Vault: injector.RefusingVault{}, Secrets: &s.values, CA: cellCA.Cert, CAKey: cellCA.Key,
		TrustedProxies: trustedProxies, UpstreamRoots: upstreamCA.Pool(),
		// Whatever address the egress validated for the name, the host here is the local server.
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, up.Listener.Addr().String())
		},
	}
	go func() { _ = inj.Serve(ctx, l) }()
	return s
}

// Grant gives the claim one secret for allowed and another for other, both
// credential hosts, pushes the claim's policy to the egress and the
// injector, and returns the first's placeholder and value. The call is a
// python3 program in the machine that trusts the cell CA and sends the
// placeholder from KODY_CONF_SECRET.
func (s *InjectorSecrets) Grant(t *testing.T, claimID, orgID string, n driver.ClaimNetwork, sources []string, allowed, other string) (string, string, func(string) string) {
	t.Helper()
	mine, err := policy.NewPlaceholder()
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := policy.NewPlaceholder()
	if err != nil {
		t.Fatal(err)
	}
	value := "conformance_value_" + strings.TrimPrefix(mine, policy.PlaceholderPrefix)[:12]
	s.values.mu.Lock()
	s.values.m[orgID+"/npm_token"] = injector.StoredSecret{Value: value, Hosts: []string{allowed}}
	s.values.m[orgID+"/other_token"] = injector.StoredSecret{Value: "other_value", Hosts: []string{other}}
	s.values.mu.Unlock()
	now := time.Now()
	p := policy.ClaimPolicy{
		ClaimID: claimID, OrgID: orgID, EnvironmentID: "env-conformance", Sources: sources,
		Allow: []string{allowed, other}, CredentialHosts: []string{allowed, other}, SteerTo: n.EgressAddress,
		Secrets: []policy.Secret{{ID: "npm_token", Placeholder: mine, Hosts: []string{allowed}}, {ID: "other_token", Placeholder: theirs, Hosts: []string{other}}},
		Phase:   policy.PhaseTest, ExpiresAt: now.Add(time.Hour), IssuedAt: now,
	}
	if err := s.policies.Put(p); err != nil {
		t.Fatal(err)
	}
	if err := s.push(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	call := func(host string) string {
		return "python3 - <<'PY'\n" + fmt.Sprintf(`import os, ssl, http.client
ctx = ssl.create_default_context(cadata=%q)
c = http.client.HTTPSConnection(%q, 443, context=ctx, timeout=15)
c.request("GET", "/pkg", headers={"Authorization": "Bearer " + os.environ["KODY_CONF_SECRET"]})
r = c.getresponse()
print(r.status, r.read().decode())`, s.caPEM, host) + "\nPY"
	}
	return mine, value, call
}

func (s *InjectorSecrets) Received(host string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.received[host]
}
