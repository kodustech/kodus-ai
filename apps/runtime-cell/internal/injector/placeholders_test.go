package injector

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/egress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// Synthetic fixtures only: no value here is a real credential.
const (
	npmHost  = "npm.registry.test"
	apiHost  = "api.payments.test"
	npmValue = "npm_synthetic_value_7f3a91c2d4"
	apiValue = "sk_test_synthetic_value_51e8b0"
)

// memorySecrets is the store as the API leaves it: Delete is the admin
// deleting the secret, SetHosts the admin changing its hosts.
type memorySecrets struct {
	mu   sync.Mutex
	byID map[string]StoredSecret // org|id
}

func (m *memorySecrets) Put(org, id string, s StoredSecret) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.byID == nil {
		m.byID = map[string]StoredSecret{}
	}
	m.byID[org+"|"+id] = s
}

func (m *memorySecrets) Delete(org, id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.byID, org+"|"+id)
}

func (m *memorySecrets) Secret(_ context.Context, org, id string) (StoredSecret, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.byID[org+"|"+id]
	if !ok {
		return StoredSecret{}, ErrVaultDenied
	}
	return s, nil
}

// secretRig is a claim with two placeholder secrets, npm (for npmHost) and
// payments (for apiHost), behind the real proxy and injector. The VM trusts
// the cell CA; both upstreams answer on one TLS server.
type secretRig struct {
	vm           *http.Client
	plainVM      *http.Client
	alerts       chan Alert
	seen         chan *http.Request
	npm, payment policy.Secret
	events       *egress.Events
	leaks        chan string
	reg          *metrics.Registry
}

// newSecretRig's upstream reflects the request (S-50); upstream, when given,
// answers instead (after the request is recorded).
func newSecretRig(t *testing.T, store SecretStore, upstream ...http.HandlerFunc) *secretRig {
	t.Helper()
	cellCA, _ := testpki.NewCA("cell-ca")
	publicCA, _ := testpki.NewCA("public-ca")
	upCert, _ := publicCA.Issue(npmHost, time.Hour, npmHost, apiHost)
	r := &secretRig{alerts: make(chan Alert, 8), seen: make(chan *http.Request, 8), leaks: make(chan string, 8)}
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		seen := req.Clone(req.Context())
		seen.Body = io.NopCloser(strings.NewReader(string(body)))
		r.seen <- seen
		if len(upstream) > 0 {
			upstream[0](w, seen)
			return
		}
		_ = req.Header.Write(w) // an upstream that reflects the request (S-50)
	}))
	up.TLS = &tls.Config{Certificates: []tls.Certificate{upCert}}
	up.StartTLS()
	t.Cleanup(up.Close)
	upAddr := strings.TrimPrefix(up.URL, "https://")

	npmPlaceholder, _ := policy.NewPlaceholder()
	apiPlaceholder, _ := policy.NewPlaceholder()
	spec := policy.Spec{
		ClaimID: "claim-1", OrgID: "org-a", Phase: policy.PhaseBuild, Sources: []string{"127.0.0.1"},
		Base: []string{"plain.example.test"}, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
		Secrets: []policy.Secret{
			{ID: "npm", Placeholder: npmPlaceholder, Hosts: []string{npmHost}},
			{ID: "payments", Placeholder: apiPlaceholder, Hosts: []string{apiHost}},
		},
	}
	pol, _, err := policy.Build(spec, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.npm, r.payment = pol.Secrets[0], pol.Secrets[1]
	policies := policy.NewStore(nil)
	if err := policies.Put(pol); err != nil {
		t.Fatal(err)
	}
	r.reg = metrics.NewRegistry()
	inj := &Injector{
		Metrics:  NewMetrics(r.reg),
		Policies: policies, Vault: RefusingVault{}, Secrets: store, CA: cellCA.Cert, CAKey: cellCA.Key,
		TrustedProxies: []string{"127.0.0.1"}, UpstreamRoots: publicCA.Pool(), InternalCIDRs: loopbackNet(),
		Alerts: eventlog.New[Alert](10), OnAlert: func(a Alert) { r.alerts <- a },
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, upAddr)
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	il, _ := net.Listen("tcp4", "127.0.0.1:0")
	go func() { _ = inj.Serve(ctx, il) }()

	plainUp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { r.seen <- req.Clone(req.Context()) }))
	t.Cleanup(plainUp.Close)
	r.events = egress.NewEvents(10)
	px := &egress.Proxy{
		Policies: policies, Events: r.events, InjectorAddr: il.Addr().String(), InternalCIDRs: loopbackNet(),
		Resolve:           func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("127.0.0.1")}, nil },
		OnPlaceholderLeak: func(_, host string) { r.leaks <- host },
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if addr != il.Addr().String() {
				addr = strings.TrimPrefix(plainUp.URL, "http://")
			}
			return (&net.Dialer{}).DialContext(ctx, network, addr)
		},
	}
	tl, _ := net.Listen("tcp4", "127.0.0.1:0")
	pl, _ := net.Listen("tcp4", "127.0.0.1:0")
	go func() { _ = px.Serve(ctx, tl, 443, true) }()
	go func() { _ = px.Serve(ctx, pl, 80, false) }()
	dialTo := func(addr string) func(context.Context, string, string) (net.Conn, error) {
		return func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp4", addr)
		}
	}
	r.vm = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: cellCA.Pool()}, DialContext: dialTo(tl.Addr().String())}}
	r.plainVM = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DialContext: dialTo(pl.Addr().String())}}
	return r
}

func (r *secretRig) do(t *testing.T, method, url string, header http.Header) (int, string) {
	t.Helper()
	client := r.vm
	if strings.HasPrefix(url, "http://") {
		client = r.plainVM
	}
	req, _ := http.NewRequest(method, url, nil)
	req.Header = header
	resp, err := client.Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func (r *secretRig) upstreamSaw(t *testing.T) *http.Request {
	t.Helper()
	select {
	case req := <-r.seen:
		return req
	case <-time.After(5 * time.Second):
		t.Fatal("the upstream saw nothing")
		return nil
	}
}

func (r *secretRig) upstreamSawNothing(t *testing.T) {
	t.Helper()
	select {
	case req := <-r.seen:
		t.Fatalf("the upstream saw a request to %s", req.Host)
	default:
	}
}

func fullStore() *memorySecrets {
	s := &memorySecrets{}
	s.Put("org-a", "npm", StoredSecret{Value: npmValue, Hosts: []string{npmHost}})
	s.Put("org-a", "payments", StoredSecret{Value: apiValue, Hosts: []string{apiHost}})
	return s
}

func TestPlaceholderReachesItsHostAsTheValueAndTheVMNeverSeesIt(t *testing.T) {
	r := newSecretRig(t, fullStore())
	status, body := r.do(t, http.MethodGet, "https://"+npmHost+"/pkg", http.Header{
		"Authorization": {"Bearer " + r.npm.Placeholder},
		"X-Npm-Token":   {r.npm.Placeholder},
	})
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	got := r.upstreamSaw(t)
	if got.Header.Get("Authorization") != "Bearer "+npmValue || got.Header.Get("X-Npm-Token") != npmValue {
		t.Fatal("the upstream did not receive the value in place of the placeholder")
	}
	if strings.Contains(body, npmValue) {
		t.Fatal("the reflected value reached the VM")
	}
}

func TestPlaceholderInBasicCredentialsReachesItsHostAsTheValue(t *testing.T) {
	r := newSecretRig(t, fullStore())
	basic := base64.StdEncoding.EncodeToString([]byte("ci:" + r.npm.Placeholder))
	if status, _ := r.do(t, http.MethodGet, "https://"+npmHost+"/pkg", http.Header{"Authorization": {"Basic " + basic}}); status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	user, pass, ok := r.upstreamSaw(t).BasicAuth()
	if !ok || user != "ci" || pass != npmValue {
		t.Fatal("the upstream did not receive the value as the Basic password")
	}
}

func TestPlaceholderSentToAnotherSecretsHostIsNotSwappedAndAlerts(t *testing.T) {
	r := newSecretRig(t, fullStore())
	status, _ := r.do(t, http.MethodPost, "https://"+npmHost+"/collect", http.Header{"X-Leak": {r.payment.Placeholder}})
	if status != http.StatusForbidden {
		t.Fatalf("status %d", status)
	}
	select {
	case a := <-r.alerts:
		if a.Kind != AlertCredentialExfiltration || a.Host != npmHost || a.ClaimID != "claim-1" {
			t.Fatalf("alert %+v", a)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no exfiltration alert")
	}
	r.upstreamSawNothing(t)
}

func TestPlaceholderOverPlainHTTPIsRefusedAtTheProxyAndReported(t *testing.T) {
	r := newSecretRig(t, fullStore())
	basic := base64.StdEncoding.EncodeToString([]byte("x:" + r.npm.Placeholder))
	status, _ := r.do(t, http.MethodGet, "http://plain.example.test/?k=1", http.Header{"Authorization": {"Basic " + basic}})
	if status == http.StatusOK {
		t.Fatal("a plain HTTP request carrying a placeholder went out")
	}
	select {
	case host := <-r.leaks:
		if host != "plain.example.test" {
			t.Fatalf("leak reported for %s", host)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no placeholder leak reported")
	}
	r.upstreamSawNothing(t)
}

func TestDeletedSecretStopsBeingInjected(t *testing.T) {
	store := fullStore()
	r := newSecretRig(t, store)
	header := http.Header{"Authorization": {"Bearer " + r.npm.Placeholder}}
	if status, _ := r.do(t, http.MethodGet, "https://"+npmHost+"/pkg", header); status != http.StatusOK {
		t.Fatalf("status %d before the delete", status)
	}
	r.upstreamSaw(t)
	store.Delete("org-a", "npm")
	if status, _ := r.do(t, http.MethodGet, "https://"+npmHost+"/pkg", header); status != http.StatusForbidden {
		t.Fatalf("status %d after the delete", status)
	}
	r.upstreamSawNothing(t)
}

func TestSecretWhoseHostTheAdminRemovedIsNotInjectedThere(t *testing.T) {
	store := fullStore()
	store.Put("org-a", "npm", StoredSecret{Value: npmValue, Hosts: []string{"npm.other.test"}})
	r := newSecretRig(t, store)
	if status, _ := r.do(t, http.MethodGet, "https://"+npmHost+"/pkg", http.Header{"Authorization": {"Bearer " + r.npm.Placeholder}}); status != http.StatusForbidden {
		t.Fatalf("status %d", status)
	}
	r.upstreamSawNothing(t)
}

func TestHostWithPlaceholderSecretsIsRefusedWithoutAStore(t *testing.T) {
	r := newSecretRig(t, nil)
	if status, _ := r.do(t, http.MethodGet, "https://"+npmHost+"/pkg", http.Header{"Authorization": {"Bearer " + r.npm.Placeholder}}); status != http.StatusForbidden {
		t.Fatalf("status %d", status)
	}
	r.upstreamSawNothing(t)
}

// The swaps and the alerts are counted (cell_injector_swaps_total,
// cell_injector_alerts_total), by outcome and kind only: never a host or a claim.
func TestSwapsAndAlertsAreCountedByOutcomeAndKind(t *testing.T) {
	r := newSecretRig(t, fullStore())
	if status, _ := r.do(t, http.MethodGet, "https://"+npmHost+"/pkg", http.Header{"X-Npm-Token": {r.npm.Placeholder}}); status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	r.upstreamSaw(t)
	if status, _ := r.do(t, http.MethodPost, "https://"+npmHost+"/collect", http.Header{"X-Leak": {r.payment.Placeholder}}); status != http.StatusForbidden {
		t.Fatalf("status %d", status)
	}
	<-r.alerts
	var text strings.Builder
	_ = r.reg.WriteText(&text)
	for _, want := range []string{`cell_injector_swaps_total{outcome="swapped"} 1`, `cell_injector_alerts_total{kind="` + AlertCredentialExfiltration + `"} 1`} {
		if !strings.Contains(text.String(), want) {
			t.Errorf("no %s in:\n%s", want, text.String())
		}
	}
	if strings.Contains(text.String(), npmHost) || strings.Contains(text.String(), "claim-1") {
		t.Fatal("a host or a claim became a label")
	}
}
