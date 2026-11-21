package machinetrust

import (
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

func mustCA(t *testing.T, name string) *testpki.CA {
	t.Helper()
	ca, err := testpki.NewCA(name)
	if err != nil {
		t.Fatal(err)
	}
	return ca
}

// verifies reports whether a leaf ca issued for host verifies against pemRoots.
func verifies(t *testing.T, pemRoots []byte, ca *testpki.CA, host string) bool {
	t.Helper()
	leaf, err := ca.Issue(host, time.Hour, host)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(leaf.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemRoots) {
		t.Fatal("no certificate in the bundle")
	}
	_, err = cert.Verify(x509.VerifyOptions{DNSName: host, Roots: pool})
	return err == nil
}

func TestAMachineWithASecretTrustsTheInjectorAndStillTrustsPublicHosts(t *testing.T) {
	public, other, cell := mustCA(t, "public-root"), mustCA(t, "another-public-root"), mustCA(t, "cell-ca")
	roots := append(append([]byte{}, public.PEM...), other.PEM...)
	files, err := Write(filepath.Join(t.TempDir(), "trust"), roots, cell.PEM)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := os.ReadFile(files.Bundle)
	if err != nil {
		t.Fatal(err)
	}
	// The injector's leaf for a secret's host, and a public host's own leaf.
	if !verifies(t, bundle, cell, "npm.registry.test") {
		t.Error("the bundle does not trust the injector's leaf")
	}
	if !verifies(t, bundle, public, "registry.npmjs.org") || !verifies(t, bundle, other, "github.com") {
		t.Error("the bundle no longer trusts the public roots")
	}
	// Node's file is the cell CA alone: Node adds it to its own roots.
	ca, err := os.ReadFile(files.CellCA)
	if err != nil {
		t.Fatal(err)
	}
	if !verifies(t, ca, cell, "npm.registry.test") || verifies(t, ca, public, "registry.npmjs.org") {
		t.Error("cell-ca.pem is not the cell CA alone")
	}
	for _, p := range []string{files.Bundle, files.CellCA} {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o644 {
			t.Errorf("%s is %v, want 0644 (read by the machines' users)", p, st.Mode().Perm())
		}
	}
}

func TestTheCellCAFileGivesItsCertificateOnly(t *testing.T) {
	public, cell := mustCA(t, "public-root"), mustCA(t, "cell-ca")
	key := []byte("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n")
	leaf, err := cell.Issue("not-a-ca", time.Hour, "not-a-ca")
	if err != nil {
		t.Fatal(err)
	}
	leafPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leaf.Certificate[0]})
	for name, ca := range map[string][]byte{
		"with its key":     append(append([]byte{}, cell.PEM...), key...),
		"two certificates": append(append([]byte{}, cell.PEM...), public.PEM...),
		"no certificate":   nil,
		"not a CA":         leafPEM,
		"garbage":          []byte("not pem"),
	} {
		if _, _, err := Build(public.PEM, ca); err == nil {
			t.Errorf("%s: built", name)
		}
	}
	if _, _, err := Build([]byte("no roots"), cell.PEM); err == nil {
		t.Error("built without a public root")
	}
	// What is not a certificate in the roots never reaches the bundle.
	bundle, _, err := Build(append(append([]byte{}, public.PEM...), key...), cell.PEM)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(bundle), "PRIVATE KEY") || strings.Count(string(bundle), "BEGIN CERTIFICATE") != 2 {
		t.Errorf("bundle: %s", bundle)
	}
}

func TestReadRootsTakesTheFirstStoreThatHoldsACertificate(t *testing.T) {
	dir := t.TempDir()
	empty, good := filepath.Join(dir, "empty.pem"), filepath.Join(dir, "good.pem")
	if err := os.WriteFile(empty, []byte("nothing"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(good, mustCA(t, "root").PEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, from, err := ReadRoots([]string{filepath.Join(dir, "missing"), empty, good}); err != nil || from != good {
		t.Fatalf("from %q: %v", from, err)
	}
	if _, _, err := ReadRoots([]string{empty}); err == nil {
		t.Fatal("read roots from a store with none")
	}
}

func TestEnvPointsEveryVariableAtTheMountedFiles(t *testing.T) {
	env := Env(BundleTarget, CellCATarget)
	if len(env) != len(EnvNames) {
		t.Fatalf("env %v names %d variables, EnvNames %d", env, len(env), len(EnvNames))
	}
	for _, n := range EnvNames {
		want := BundleTarget
		if n == "NODE_EXTRA_CA_CERTS" {
			want = CellCATarget
		}
		if env[n] != want || !IsEnvName(n) {
			t.Errorf("%s = %q, want %q", n, env[n], want)
		}
	}
	if (Files{}).SandboxMounts() != nil || (Files{Bundle: "/b"}).Set() {
		t.Error("an unset Files mounts something")
	}
	m := Files{Bundle: "/h/b.pem", CellCA: "/h/c.pem"}.SandboxMounts()
	if strings.Join(m, " ") != "/h/b.pem:"+BundleTarget+" /h/c.pem:"+CellCATarget+" /h/b.pem:"+SystemStoreTarget {
		t.Errorf("sandbox mounts %v", m)
	}
}
