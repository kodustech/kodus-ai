package dockergvisor

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

var cellTrust = machinetrust.Files{Bundle: "/var/lib/kodus-cell/trust/ca-bundle.pem", CellCA: "/var/lib/kodus-cell/trust/cell-ca.pem"}

func trustDriver(t *testing.T) (*Driver, *recorder) {
	t.Helper()
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`, "run": "c0ffee\n", "inspect": holderJSON, "network subnet": "10.213.5.0/24 \n"}}
	d, err := New(context.Background(), dockercli.CLI{Run: r.run}, Config{
		CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", SandboxImage: "kodus/sandbox@sha256:def", WorkDir: t.TempDir(), Trust: cellTrust,
	})
	if err != nil {
		t.Fatal(err)
	}
	return d, r
}

// binds are the -v values of a docker run.
func binds(args []string) []string {
	var out []string
	for i, a := range args {
		if a == "-v" && i+1 < len(args) {
			out = append(out, args[i+1])
		}
	}
	return out
}

func TestASandboxOfAClaimWithSecretsMountsTheCellsTrustFiles(t *testing.T) {
	for _, trust := range []bool{true, false} {
		d, r := trustDriver(t)
		if !d.SandboxesEnabled() {
			t.Fatal("no sandboxes")
		}
		if _, err := d.CreateSandbox(context.Background(), driver.SandboxRequest{Spec: spec(), CellTrust: trust}); err != nil {
			t.Fatal(err)
		}
		run := r.find("run")
		if run == nil {
			t.Fatal("no docker run")
		}
		got := binds(run)
		want := []string{
			cellTrust.Bundle + ":" + machinetrust.BundleTarget + ":ro",
			cellTrust.CellCA + ":" + machinetrust.CellCATarget + ":ro",
			cellTrust.Bundle + ":" + machinetrust.SystemStoreTarget + ":ro",
		}
		for _, w := range want {
			if slices.Contains(got, w) != trust {
				t.Errorf("trust %v: bind %s in %v", trust, w, got)
			}
		}
		if !trust && strings.Contains(strings.Join(got, " "), "trust/") {
			t.Errorf("a sandbox without secrets mounts the cell's files: %v", got)
		}
	}
}

// Up of a claim with secrets renders the trust files into every service:
// what compose would run without them is refused, and a claim without
// secrets needs none.
func TestUpOfAClaimWithSecretsWantsTheTrustFilesInEveryService(t *testing.T) {
	inspect := `[{"Id":"s1","Name":"/kodus-claim-1-workload-a-1","Config":{"Labels":{"kodus.cell":"cell-1"}},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":"172.30.0.9"}}}}]`
	trusted := `"volumes":[{"type":"bind","source":"` + cellTrust.Bundle + `","target":"` + machinetrust.BundleTarget + `","read_only":true},` +
		`{"type":"bind","source":"` + cellTrust.CellCA + `","target":"` + machinetrust.CellCATarget + `","read_only":true}],` +
		`"environment":{"SSL_CERT_FILE":"` + machinetrust.BundleTarget + `","REQUESTS_CA_BUNDLE":"` + machinetrust.BundleTarget +
		`","CURL_CA_BUNDLE":"` + machinetrust.BundleTarget + `","GIT_SSL_CAINFO":"` + machinetrust.BundleTarget + `","NODE_EXTRA_CA_CERTS":"` + machinetrust.CellCATarget + `"},"extra_hosts"`
	up := func(trust bool, canonical string) error {
		d, r := trustDriver(t)
		ref, err := d.Create(context.Background(), spec())
		if err != nil {
			t.Fatal(err)
		}
		ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
		r.answers["compose config"], r.answers["ps"], r.answers["inspect"] = canonical, "s1\n", inspect
		_, err = d.Up(context.Background(), driver.UpRequest{Ref: ref, Compose: []byte("services:\n  a:\n    image: x\n"), ProjectDir: t.TempDir(), CellTrust: trust})
		return err
	}
	dir := t.TempDir()
	plain := canonicalFor(dir)
	withTrust := strings.Replace(plain, `"extra_hosts"`, trusted, 1)
	if err := up(true, withTrust); err != nil {
		t.Fatalf("a claim with secrets, trust rendered: %v", err)
	}
	var re *sandbox.RefusedError
	if err := up(true, plain); !errors.As(err, &re) || !strings.Contains(err.Error(), "trust files") {
		t.Fatalf("a claim with secrets ran without the trust files: %v", err)
	}
	if err := up(false, plain); err != nil {
		t.Fatalf("a claim without secrets: %v", err)
	}
}
