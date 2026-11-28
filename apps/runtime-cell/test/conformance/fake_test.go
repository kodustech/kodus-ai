//go:build unix

package conformance

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/egress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// fakeMachines is the fake driver with its sandboxes: the real guest agent
// on host directories (fake.Sandboxes).
type fakeMachines struct {
	*fake.Driver
	fake.Sandboxes
}

// The fake isolates nothing: what it proves is what does not depend on a
// boundary, the guest agent's no-follow rules, one machine and directory per
// claim, a released machine's files going with it, and the injector's swap
// for a machine's placeholder (the injector is outside the machine on every
// backend).
func TestTheFakeDriverKeepsTheBehavioursThatNeedNoBoundary(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is required")
	}
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("curl is required")
	}
	root := t.TempDir()
	d := fake.NewForCell("cell-conf")
	m := fakeMachines{Driver: d, Sandboxes: fake.Sandboxes{Driver: d, Root: root}}
	Run(t, Target{
		Name: "fake", CellID: "cell-conf", Driver: m,
		Secrets: newInProcessSecrets(t), SecretHost: "registry.secret.test", NotSecretHost: "other.secret.test",
		Leftovers: func(t *testing.T, machineID string) []string {
			if _, err := os.Stat(filepath.Join(root, machineID)); errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return []string{filepath.Join(root, machineID)}
		},
	})
}

// inProcessSecrets is the cell's credential path in process: one policy
// store for the proxy and the injector, the injector reading values from a
// map, and one TLS upstream that records what each host received.
type inProcessSecrets struct {
	policies *policy.Store
	values   mapSecrets
	caFile   string
	tlsPort  int

	mu       sync.Mutex
	received map[string]string
}

type mapSecrets map[string]injector.StoredSecret

func (m mapSecrets) Secret(_ context.Context, org, id string) (injector.StoredSecret, error) {
	s, ok := m[org+"/"+id]
	if !ok {
		return injector.StoredSecret{}, errors.New("no such secret")
	}
	return s, nil
}

func newInProcessSecrets(t *testing.T) *inProcessSecrets {
	t.Helper()
	s := &inProcessSecrets{policies: policy.NewStore(nil), values: mapSecrets{}, received: map[string]string{}}
	cellCA, _ := testpki.NewCA("cell-ca")
	publicCA, _ := testpki.NewCA("public-ca")
	upCert, _ := publicCA.Issue("upstream", time.Hour, "registry.secret.test", "other.secret.test")
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.received[r.Host] = r.Header.Get("Authorization")
		s.mu.Unlock()
		_, _ = w.Write([]byte("ok"))
	}))
	up.TLS = &tls.Config{Certificates: []tls.Certificate{upCert}, MinVersion: tls.VersionTLS12}
	up.StartTLS()
	t.Cleanup(up.Close)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	loopback, _ := netguard.ParseCIDRs("127.0.0.0/8")
	toUpstream := func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(up.URL, "https://"))
	}
	inj := &injector.Injector{
		Policies: s.policies, Vault: injector.RefusingVault{}, Secrets: s.values, CA: cellCA.Cert, CAKey: cellCA.Key,
		TrustedProxies: []string{"127.0.0.1"}, UpstreamRoots: publicCA.Pool(), InternalCIDRs: loopback,
		Alerts: eventlog.New[injector.Alert](10), Dial: toUpstream,
	}
	il, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = inj.Serve(ctx, il) }()
	px := &egress.Proxy{
		Policies: s.policies, Events: egress.NewEvents(10), InjectorAddr: il.Addr().String(), InternalCIDRs: loopback,
		Resolve: func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("127.0.0.1")}, nil },
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if addr == il.Addr().String() {
				return (&net.Dialer{}).DialContext(ctx, network, addr)
			}
			return toUpstream(ctx, network, addr)
		},
	}
	tl, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = px.Serve(ctx, tl, 443, true) }()
	s.tlsPort = tl.Addr().(*net.TCPAddr).Port
	s.caFile = filepath.Join(t.TempDir(), "cell-ca.pem")
	if err := os.WriteFile(s.caFile, cellCA.PEM, 0o600); err != nil {
		t.Fatal(err)
	}
	return s
}

// Grant gives the claim one secret for allowed and another for other, both
// credential hosts, and returns the first's placeholder and value.
func (s *inProcessSecrets) Grant(t *testing.T, claimID, orgID string, _ driver.ClaimNetwork, sources []string, allowed, other string) (string, string, func(string) string) {
	t.Helper()
	mine, _ := policy.NewPlaceholder()
	theirs, _ := policy.NewPlaceholder()
	value := "conformance_value_" + strings.TrimPrefix(mine, policy.PlaceholderPrefix)[:12]
	s.values[orgID+"/npm_token"] = injector.StoredSecret{Value: value, Hosts: []string{allowed}}
	s.values[orgID+"/other_token"] = injector.StoredSecret{Value: "other_value", Hosts: []string{other}}
	now := time.Now()
	if err := s.policies.Put(policy.ClaimPolicy{
		ClaimID: claimID, OrgID: orgID, EnvironmentID: "env-conformance", Sources: sources,
		Allow: []string{allowed, other}, CredentialHosts: []string{allowed, other},
		Secrets: []policy.Secret{{ID: "npm_token", Placeholder: mine, Hosts: []string{allowed}}, {ID: "other_token", Placeholder: theirs, Hosts: []string{other}}},
		Phase:   policy.PhaseTest, ExpiresAt: now.Add(time.Hour), IssuedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	call := func(host string) string {
		return fmt.Sprintf(`curl -sS --max-time 15 --cacert %s --connect-to %s:443:127.0.0.1:%d -H "Authorization: Bearer $KODY_CONF_SECRET" https://%s/pkg`, s.caFile, host, s.tlsPort, host)
	}
	return mine, value, call
}

func (s *inProcessSecrets) Received(host string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.received[host]
}
