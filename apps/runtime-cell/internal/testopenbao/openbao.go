// Package testopenbao runs OpenBao as Kodus ships it (the repository's
// docker/openbao config and policies, Postgres storage, static auto-unseal,
// the self-initialized AppRoles) in throwaway containers, for the dockersmoke
// tests of the injector and of the cell agent. It also takes an OpenBao
// started elsewhere (Env), so a test driven from the TypeScript side reads
// what the API wrote. Nothing here is production code.
package testopenbao

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// Image is the one docker-compose.dev.yml pins (runtime-openbao).
const Image = "openbao/openbao:2.7.2@sha256:5046911075e137e154ce49ab051502f4ec7cf367d484ae4a4dce665d9b90561f"

const postgresImage = "docker.io/pgvector/pgvector:pg16"

// Mount is the KV v2 mount the self-initialization creates.
const Mount = "runtime-kv"

// Bao is one OpenBao: its address, the CA its certificate chains to, and
// the directory of the AppRoles' role and secret ids (api-*, injector-*).
type Bao struct {
	Address string
	Roots   *x509.CertPool
	// Dir holds api-role-id, api-secret-id, injector-role-id,
	// injector-secret-id, as scripts/runtime/dev-openbao.sh writes them.
	Dir    string
	Name   string // the container's name; empty for one started elsewhere
	client *http.Client
}

// RepoRoot is the repository's root, from this file's place in it.
func RepoRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", ".."))
}

func docker(t testing.TB, args ...string) string {
	t.Helper()
	out, err := exec.CommandContext(context.Background(), "docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out))
}

// RandomHex is n random bytes in hex.
func RandomHex(t testing.TB, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

func newBao(roots *x509.CertPool, dir, name string) *Bao {
	return &Bao{
		Roots: roots, Dir: dir, Name: name,
		client: &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}}},
	}
}

// Env is an OpenBao started elsewhere (scripts/runtime/dev-openbao.sh and
// its compose profile, or the TypeScript integration that drives a test):
// KGR_OPENBAO_ADDR, KGR_OPENBAO_CA_FILE and KGR_OPENBAO_DIR (the AppRoles'
// files). false when KGR_OPENBAO_ADDR is unset.
func Env(t testing.TB) (*Bao, bool) {
	t.Helper()
	addr := os.Getenv("KGR_OPENBAO_ADDR")
	if addr == "" {
		return nil, false
	}
	pem, err := os.ReadFile(os.Getenv("KGR_OPENBAO_CA_FILE"))
	if err != nil {
		t.Fatalf("KGR_OPENBAO_CA_FILE: %v", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		t.Fatal("KGR_OPENBAO_CA_FILE holds no certificate")
	}
	b := newBao(roots, os.Getenv("KGR_OPENBAO_DIR"), "")
	b.Address = strings.TrimRight(addr, "/")
	return b, true
}

// Start runs OpenBao and its Postgres in throwaway containers, removed when
// the test ends; it skips the test without docker.
func Start(t testing.TB) *Bao {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker is required")
	}
	root := RepoRoot()
	dir := t.TempDir()
	ca, err := testpki.NewCA("openbao-smoke")
	if err != nil {
		t.Fatal(err)
	}
	cert, err := ca.Issue("runtime-openbao", time.Hour, "runtime-openbao", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if err := ca.WriteFiles(dir, "tls-", cert); err != nil {
		t.Fatal(err)
	}
	for from, to := range map[string]string{"tls-cert.pem": "tls.pem", "tls-key.pem": "tls.key"} {
		if err := os.Rename(filepath.Join(dir, from), filepath.Join(dir, to)); err != nil {
			t.Fatal(err)
		}
	}
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	files := map[string][]byte{"unseal.key": key}
	for _, f := range []string{"api-role-id", "api-secret-id", "injector-role-id", "injector-secret-id"} {
		files[f] = []byte(RandomHex(t, 24))
	}
	for f, b := range files {
		if err := os.WriteFile(filepath.Join(dir, f), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	suffix := RandomHex(t, 4)
	network, pg, bao := "bao-smoke-"+suffix, "bao-smoke-pg-"+suffix, "bao-smoke-"+suffix
	pgPassword := RandomHex(t, 16)
	docker(t, "network", "create", network)
	t.Cleanup(func() {
		_ = exec.CommandContext(context.Background(), "docker", "rm", "-f", bao, pg).Run()
		_ = exec.CommandContext(context.Background(), "docker", "network", "rm", network).Run()
	})
	docker(t, "run", "-d", "--name", pg, "--network", network, "-e", "POSTGRES_USER=openbao", "-e", "POSTGRES_PASSWORD="+pgPassword, "-e", "POSTGRES_DB=kodus_openbao", postgresImage)
	WaitFor(t, 60*time.Second, func() bool {
		return exec.CommandContext(context.Background(), "docker", "exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "openbao", "-d", "kodus_openbao").Run() == nil
	})
	docker(t, "run", "-d", "--name", bao, "--network", network, "--network-alias", "runtime-openbao", "--cap-add", "IPC_LOCK",
		// The host user, so the 0600 key files stay unreadable to anyone else.
		"--user", strconv.Itoa(os.Getuid())+":"+strconv.Itoa(os.Getgid()),
		"-p", "127.0.0.1::8200",
		"-e", "BAO_PG_CONNECTION_URL=postgres://openbao:"+pgPassword+"@"+pg+":5432/kodus_openbao?sslmode=disable",
		"-v", filepath.Join(root, "docker", "openbao", "config")+":/openbao/config:ro",
		"-v", filepath.Join(root, "docker", "openbao", "policies")+":/openbao/policies:ro",
		"-v", dir+":/openbao/secrets:ro",
		"--entrypoint", "bao", Image, "server", "-config=/openbao/config")
	b := newBao(ca.Pool(), dir, bao)
	b.WaitReady(t)
	return b
}

// Restart restarts the container and waits for it to unseal itself.
func (b *Bao) Restart(t testing.TB) {
	t.Helper()
	docker(t, "restart", b.Name)
	b.WaitReady(t)
}

// published is the host port Docker gave 8200: it changes on a restart.
func (b *Bao) published(t testing.TB) {
	t.Helper()
	port := docker(t, "port", b.Name, "8200/tcp")
	b.Address = "https://127.0.0.1:" + port[strings.LastIndex(port, ":")+1:]
}

// WaitFor polls ok until it holds, failing the test after limit.
func WaitFor(t testing.TB, limit time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// WaitReady waits for the self-initialization to have created the
// injector's role: a login that works means the whole init ran.
func (b *Bao) WaitReady(t testing.TB) {
	t.Helper()
	if b.Name != "" {
		b.published(t)
	}
	WaitFor(t, 60*time.Second, func() bool {
		status, _ := b.Call(t, "", http.MethodPost, "/v1/auth/approle/login", b.loginBody(t, "injector"))
		return status == http.StatusOK
	})
}

// RoleFiles are the role id and secret id files of an AppRole (api or injector).
func (b *Bao) RoleFiles(role string) (roleID, secretID string) {
	return filepath.Join(b.Dir, role+"-role-id"), filepath.Join(b.Dir, role+"-secret-id")
}

func (b *Bao) loginBody(t testing.TB, role string) map[string]any {
	t.Helper()
	read := func(f string) string {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	roleID, secretID := b.RoleFiles(role)
	return map[string]any{"role_id": read(roleID), "secret_id": read(secretID)}
}

// Call sends one request with token (empty: none) and decodes the answer.
func (b *Bao) Call(t testing.TB, token, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var in io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		in = bytes.NewReader(raw)
	}
	req, _ := http.NewRequestWithContext(context.Background(), method, b.Address+path, in)
	if token != "" {
		req.Header.Set("X-Vault-Token", token)
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return 0, nil
	}
	defer func() { _ = resp.Body.Close() }()
	var out map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out)
	return resp.StatusCode, out
}

// Login is an AppRole login (api or injector); it returns the token.
func (b *Bao) Login(t testing.TB, role string) string {
	t.Helper()
	status, out := b.Call(t, "", http.MethodPost, "/v1/auth/approle/login", b.loginBody(t, role))
	auth, _ := out["auth"].(map[string]any)
	token, _ := auth["client_token"].(string)
	if status != http.StatusOK || token == "" {
		t.Fatalf("%s login: status %d", role, status)
	}
	return token
}

// WriteSecret is the API's write (libs/runtime/api/infrastructure/
// openbao-secret-vault.adapter.ts): the value and its hosts at
// <mount>/data/orgs/<org>/secrets/<id>, with the org and id the injector
// checks against the path.
func (b *Bao) WriteSecret(t testing.TB, token, org, id, value string, hosts []string) int {
	t.Helper()
	status, _ := b.Call(t, token, http.MethodPost, "/v1/"+Mount+"/data/orgs/"+org+"/secrets/"+id, map[string]any{"data": map[string]any{
		"value": value, "hosts": hosts, "organizationId": org, "secretId": id,
	}})
	return status
}
