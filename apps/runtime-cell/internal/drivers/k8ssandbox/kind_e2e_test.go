package k8ssandbox

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// On a real cluster (opt-in): a sandbox of a claim with org secrets trusts a
// server whose certificate the cell CA issued, through the system store its
// tools read (Python's default context here), under a restricted namespace;
// a sandbox of a claim without secrets does not. KODY_E2E_K8S_API is an API
// server the test reaches without credentials (kubectl proxy),
// KODY_E2E_K8S_CONTEXT the kubectl context to exec with,
// KODY_E2E_K8S_SANDBOX_IMAGE the sandbox image loaded on the nodes, and
// KODY_E2E_K8S_RUNTIME_CLASS the RuntimeClass (kind: one with handler runc).
func TestOnAClusterASandboxWithSecretsTrustsTheCellCA(t *testing.T) {
	api, kctx, image, rc := os.Getenv("KODY_E2E_K8S_API"), os.Getenv("KODY_E2E_K8S_CONTEXT"), os.Getenv("KODY_E2E_K8S_SANDBOX_IMAGE"), os.Getenv("KODY_E2E_K8S_RUNTIME_CLASS")
	if api == "" || kctx == "" || image == "" || rc == "" {
		t.Skip("KODY_E2E_K8S_API, KODY_E2E_K8S_CONTEXT, KODY_E2E_K8S_SANDBOX_IMAGE and KODY_E2E_K8S_RUNTIME_CLASS run it on a cluster")
	}
	ns := os.Getenv("KODY_E2E_K8S_NAMESPACE")
	if ns == "" {
		ns = sandboxNS
	}
	ca, err := testpki.NewCA("e2e-cell-ca")
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := ca.Issue("localhost", time.Hour, "localhost")
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(leaf.PrivateKey.(*ecdsa.PrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leaf.Certificate[0]})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	c := &Client{Base: api, HTTP: http.DefaultClient}
	d, err := New(c, c, Config{
		CellID: "cell-e2e", Namespace: ns, RuntimeClass: rc, HolderImage: image, SandboxImage: image,
		EgressAddress: "10.96.0.10", CellCA: ca.PEM, ReadyTimeout: 3 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	spec := func(claim string) driver.MachineSpec {
		return driver.MachineSpec{
			CellID: "cell-e2e", EnvironmentID: "sandbox", Role: driver.RoleWorkload, OrgID: "org-e2e", ClaimID: claim,
			ClaimSize: driver.ClaimSize{MemoryMB: 1024, CPUs: 1}, ClaimGroupID: claim, KMSKeyRef: "k8s-sandbox-org-e2e",
			ExpiresAt: time.Now().Add(10 * time.Minute), HardExpiresAt: time.Now().Add(time.Hour),
		}
	}
	// A TLS server on loopback with the leaf, and a client with Python's default context against it.
	probe := "import ssl,socket,threading\n" +
		"open('/tmp/c.pem','w').write('''" + string(certPEM) + "''');open('/tmp/k.pem','w').write('''" + string(keyPEM) + "''')\n" +
		"s=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);s.load_cert_chain('/tmp/c.pem','/tmp/k.pem')\n" +
		"l=socket.socket();l.bind(('127.0.0.1',8443));l.listen(1)\n" +
		"def serve():\n  conn,_=l.accept()\n  try:\n    s.wrap_socket(conn,server_side=True).close()\n  except Exception:\n    pass\n" +
		"threading.Thread(target=serve,daemon=True).start()\n" +
		"try:\n  ssl.create_default_context().wrap_socket(socket.create_connection(('127.0.0.1',8443)),server_hostname='localhost').close();print('verified')\n" +
		"except ssl.SSLCertVerificationError:\n  print('unverified')\n"
	run := func(claim string, trust bool) string {
		t.Helper()
		ref, err := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: spec(claim), CellTrust: trust})
		if err != nil {
			t.Fatalf("%s: %v", claim, err)
		}
		t.Cleanup(func() { _ = d.Destroy(context.Background(), ref) })
		_, name := split(ref)
		out, err := exec.Command("kubectl", "--context", kctx, "-n", ns, "exec", name, "-c", containerSandbox, "--", "python3", "-c", probe).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: exec: %v: %s", claim, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if got := run("e2e-trust", true); got != "verified" {
		t.Errorf("the sandbox with the cell's trust: %q", got)
	}
	if got := run("e2e-plain", false); got != "unverified" {
		t.Errorf("the sandbox without the cell's trust: %q", got)
	}
}
