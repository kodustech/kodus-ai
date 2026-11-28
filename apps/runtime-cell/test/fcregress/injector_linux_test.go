//go:build linux

package fcregress

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// injectorVault hands one claim one credential for one host, with a bait.
type injectorVault struct {
	claim, host, value, bait string
}

func (v injectorVault) Credential(_ context.Context, _, claimID, host string) (injector.Credential, error) {
	if claimID != v.claim || host != v.host {
		return injector.Credential{}, fmt.Errorf("no credential for %s at %s", claimID, host)
	}
	return injector.Credential{Header: "Authorization", Value: "Bearer " + v.value, ExpiresAt: time.Now().Add(time.Hour), Baits: []string{v.bait}}, nil
}

// The credential injector between a microVM and its credentialed host, as
// the cell runs it: the VM's TLS to the host goes to the cell's egress
// (the resolver steers the name there), which hands the credentialed host
// to the injector with PROXY v1; the injector shows the VM a leaf of the
// cell CA, adds the credential and masks it in the answer. Upstream is a
// local TLS server standing for the host (the injector's Dial), so nothing
// leaves for real but the egress's DNS lookup of the name.
//
// S-50: the VM never sees the credential (not in the answer that echoes it,
// not when it names the header itself) while the host gets it (the
// control). S-29: a bait the VM sends to the host is refused there and
// raises bait_exfiltration for the claim, the alert the agent's feed
// reads; so does the credential sent back out.
func TestFirecrackerInjectorKeepsTheCredentialOutOfTheVM(t *testing.T) {
	const host = "example.com"
	s := open(t)
	ctx := context.Background()
	stamp := time.Now().Format("150405")
	claim := "fc-inj-" + stamp
	n := claimNet(t, s.Driver, claim)

	ca, err := testpki.NewCA("fc-injector-cell-ca")
	if err != nil {
		t.Fatal(err)
	}
	upstreamCA, _ := testpki.NewCA("fc-upstream-ca")
	upCert, _ := upstreamCA.Issue(host, time.Hour, host)
	var mu sync.Mutex
	var gotAuth []string
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotAuth = append(gotAuth, r.Header.Get("Authorization"))
		mu.Unlock()
		// The host echoes what it got: the credential comes back in the answer.
		_ = json.NewEncoder(w).Encode(map[string]string{"authorization": r.Header.Get("Authorization"), "body": string(body)})
	}))
	up.TLS = &tls.Config{Certificates: []tls.Certificate{upCert}, MinVersion: tls.VersionTLS12}
	up.StartTLS()
	t.Cleanup(up.Close)

	secret, bait := "kfc-test-credential-"+stamp+"-9f3a71", "kfc-test-bait-"+stamp+"-c2d8e4"
	store := policy.NewStore(time.Now)
	alerts := make(chan injector.Alert, 8)
	inj := &injector.Injector{
		Policies: store, Vault: injectorVault{claim: claim, host: host, value: secret, bait: bait},
		CA: ca.Cert, CAKey: ca.Key, TrustedProxies: []string{"127.0.0.1"}, UpstreamRoots: upstreamCA.Pool(),
		// Whatever address the egress validated for the name, the host here is the local server.
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", up.Listener.Addr().String())
		},
		OnAlert: func(a injector.Alert) { alerts <- a },
	}
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ictx, stop := context.WithCancel(ctx)
	t.Cleanup(stop)
	go func() { _ = inj.Serve(ictx, l) }()

	e := startEgress(t, s.Place.Egress().String(), "-injector-addr", l.Addr().String())
	ref, err := s.Driver.CreateSandbox(ctx, driver.SandboxRequest{Spec: machineSpec(claim, n, driver.RoleWorkload, nil)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.Destroy(context.WithoutCancel(ctx), ref) })
	pol := policy.ClaimPolicy{
		ClaimID: claim, OrgID: "org-fc", Sources: []string{ref.PrivateAddress}, Allow: []string{host}, CredentialHosts: []string{host},
		SteerTo: n.EgressAddress, Phase: policy.PhaseTest, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
	}
	if err := e.push.Push(ctx, pol); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(pol); err != nil {
		t.Fatal(err)
	}
	c := answer(t, func() (*guest.Client, error) {
		rw, err := s.Driver.DialGuest(ctx, ref)
		if err != nil {
			return nil, err
		}
		return guest.NewClient(rw, cellID, claim), nil
	}, time.Minute)
	t.Cleanup(func() { _ = c.Close() })

	// Each request from the VM: its status and body, through the egress, trusting the cell CA.
	req := func(header, body string) string {
		t.Helper()
		prog := fmt.Sprintf(`import ssl, http.client
ctx = ssl.create_default_context(cadata=%q)
c = http.client.HTTPSConnection(%q, 443, context=ctx, timeout=10)
h = {}
if %q:
    h["Authorization"] = %q
c.request("POST", "/echo", body=%q, headers=h)
r = c.getresponse()
print(r.status, r.read().decode())`, string(ca.PEM), host, header, header, body)
		r := run(t, c, "python3 - <<'PY'\n"+prog+"\nPY", 60_000)
		return strings.TrimSpace(r.Stdout + r.Stderr)
	}
	plain := req("", "hello")
	chosen := req("Bearer guess-from-the-vm", "hello")
	if !strings.HasPrefix(plain, "200 ") || !strings.HasPrefix(chosen, "200 ") {
		t.Fatalf("the control failed: the credentialed host did not answer through the injector: %q / %q", plain, chosen)
	}
	mu.Lock()
	upstreamSaw := append([]string(nil), gotAuth...)
	mu.Unlock()
	if len(upstreamSaw) != 2 || upstreamSaw[0] != "Bearer "+secret || upstreamSaw[1] != "Bearer "+secret {
		t.Fatalf("the host got %q, want the injected credential both times (the VM never picks the header)", upstreamSaw)
	}
	for _, got := range []string{plain, chosen} {
		if strings.Contains(got, secret) || !strings.Contains(got, injector.Masked) {
			t.Fatalf("the VM saw the credential, or it was not masked in the echo: %q", got)
		}
	}
	t.Logf("EVIDENCE S-50 the host got %q; the VM saw %q and, naming the header itself, %q", "Bearer "+strings.Repeat("x", 6)+"…", plain, chosen)

	baitOut := req("", "token="+bait)
	if !strings.HasPrefix(baitOut, "403 ") {
		t.Fatalf("a bait went out to the host: %q", baitOut)
	}
	select {
	case a := <-alerts:
		if a.Kind != injector.AlertBaitExfiltration || a.ClaimID != claim || a.Host != host {
			t.Fatalf("alert %+v", a)
		}
		t.Logf("EVIDENCE S-29 the VM sent its bait to %s: %q; alert %s for claim %s", host, baitOut, a.Kind, a.ClaimID)
	case <-time.After(10 * time.Second):
		t.Fatal("no alert for a bait sent out")
	}
	mu.Lock()
	if len(gotAuth) != 2 {
		t.Fatalf("the bait's request reached the host: %q", gotAuth)
	}
	mu.Unlock()
}
