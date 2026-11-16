package k8ssandbox

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

func trustDriver(t *testing.T, api *apiServer, cellCA []byte) *Driver {
	t.Helper()
	c := api.client(t)
	conf := cfg()
	conf.CellCA = cellCA
	d, err := New(c, c, conf)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// A claim with org secrets on a k8s-sandbox cell that knows its cell CA: the
// sandbox pod trusts the injector the way a docker-gvisor sandbox does, the
// cell CA alone and the bundle (the tool image's roots, then the cell CA) at
// machinetrust's paths, the bundle over the system store too, all read-only.
// An unprivileged init container writes them into a memory volume from the
// certificate in the pod spec: no ConfigMap, no new RBAC, never a key.
func TestASandboxWithSecretsTrustsTheCellCAOnKubernetes(t *testing.T) {
	ca, err := testpki.NewCA("cell-ca")
	if err != nil {
		t.Fatal(err)
	}
	api := newAPIServer()
	d := trustDriver(t, api, ca.PEM)
	if !d.Capabilities().SandboxCellTrust {
		t.Fatal("a cell with its CA must say its sandboxes take the cell's trust")
	}
	if _, err := d.CreateSandbox(context.Background(), driver.SandboxRequest{Spec: sandboxSpec("claim-1"), CellTrust: true}); err != nil {
		t.Fatal(err)
	}
	spec := api.pod(sandboxNS, "workload-claim-1")["spec"].(map[string]any)

	inits, _ := spec["initContainers"].([]any)
	if len(inits) != 1 {
		t.Fatalf("init containers: %v", inits)
	}
	ic := inits[0].(map[string]any)
	if ic["image"] != "kodus/sandbox@sha256:b" {
		t.Errorf("init image %v", ic["image"])
	}
	sc := ic["securityContext"].(map[string]any)
	if sc["allowPrivilegeEscalation"] != false || sc["privileged"] != false || sc["readOnlyRootFilesystem"] != true || sc["runAsNonRoot"] != true {
		t.Errorf("init securityContext %v", sc)
	}
	if drop := sc["capabilities"].(map[string]any)["drop"].([]any); len(drop) != 1 || drop[0] != "ALL" {
		t.Errorf("init capabilities %v", drop)
	}
	var caEnv string
	for _, e := range ic["env"].([]any) {
		if m := e.(map[string]any); m["name"] == "KODUS_CELL_CA" {
			caEnv, _ = m["value"].(string)
		}
	}
	if caEnv != string(ca.PEM) {
		t.Errorf("the init container's cell CA: %q", caEnv)
	}
	if strings.Contains(caEnv, "PRIVATE KEY") {
		t.Error("a key in the pod spec")
	}

	mounts := map[string]map[string]any{}
	c := spec["containers"].([]any)[0].(map[string]any)
	for _, m := range c["volumeMounts"].([]any) {
		mm := m.(map[string]any)
		mounts[mm["mountPath"].(string)] = mm
	}
	for path, file := range map[string]string{
		machinetrust.CellCATarget:      "cell-ca.pem",
		machinetrust.BundleTarget:      "ca-bundle.pem",
		machinetrust.SystemStoreTarget: "ca-bundle.pem",
	} {
		m := mounts[path]
		if m == nil || m["name"] != "trust" || m["subPath"] != file || m["readOnly"] != true {
			t.Errorf("%s mount: %v", path, m)
		}
	}
	var trustVol map[string]any
	for _, v := range spec["volumes"].([]any) {
		if vm := v.(map[string]any); vm["name"] == "trust" {
			trustVol = vm
		}
	}
	if ed, _ := trustVol["emptyDir"].(map[string]any); ed == nil || ed["medium"] != "Memory" {
		t.Errorf("trust volume %v", trustVol)
	}
}

// Without its cell CA the driver still refuses a sandbox that must trust it,
// and a sandbox of a claim without secrets never gets the trust files.
func TestASandboxGetsTheCellTrustOnlyWhenItsClaimAsksAndTheCellHasIt(t *testing.T) {
	api := newAPIServer()
	d := trustDriver(t, api, nil)
	if d.Capabilities().SandboxCellTrust {
		t.Error("no cell CA, yet the sandboxes say they take the cell's trust")
	}
	if _, err := d.CreateSandbox(context.Background(), driver.SandboxRequest{Spec: sandboxSpec("claim-1"), CellTrust: true}); !errors.Is(err, driver.ErrUnsupported) {
		t.Fatalf("a trusted sandbox without the cell CA: %v", err)
	}
	ca, err := testpki.NewCA("cell-ca")
	if err != nil {
		t.Fatal(err)
	}
	d = trustDriver(t, api, ca.PEM)
	if _, err := d.CreateSandbox(context.Background(), driver.SandboxRequest{Spec: sandboxSpec("claim-2")}); err != nil {
		t.Fatal(err)
	}
	spec := api.pod(sandboxNS, "workload-claim-2")["spec"].(map[string]any)
	if _, has := spec["initContainers"]; has {
		t.Error("a sandbox without secrets got the trust init container")
	}
	for _, v := range spec["volumes"].([]any) {
		if v.(map[string]any)["name"] == "trust" {
			t.Error("a sandbox without secrets got the trust volume")
		}
	}
}

// New refuses a cell CA that is not exactly one CA certificate (a key, a
// leaf, two certificates), so nothing else can reach a pod spec.
func TestNewRefusesACellCAThatIsNotOneCACertificate(t *testing.T) {
	ca, err := testpki.NewCA("cell-ca")
	if err != nil {
		t.Fatal(err)
	}
	other, err := testpki.NewCA("other")
	if err != nil {
		t.Fatal(err)
	}
	key := []byte("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n")
	api := newAPIServer()
	c := api.client(t)
	for name, pem := range map[string][]byte{
		"with its key":     append(append([]byte{}, ca.PEM...), key...),
		"two certificates": append(append([]byte{}, ca.PEM...), other.PEM...),
		"garbage":          []byte("not pem"),
	} {
		conf := cfg()
		conf.CellCA = pem
		if _, err := New(c, c, conf); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
