package sandbox

import (
	"errors"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

var trustFiles = machinetrust.Files{Bundle: "/var/lib/kodus-cell/trust/ca-bundle.pem", CellCA: "/var/lib/kodus-cell/trust/cell-ca.pem"}

type appliedService struct {
	Environment map[string]any   `yaml:"environment"`
	Volumes     []map[string]any `yaml:"volumes"`
}

func applied(t *testing.T, raw string, o Options) map[string]appliedService {
	t.Helper()
	out, err := Apply([]byte(raw), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Services map[string]appliedService `yaml:"services"`
	}
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Services
}

func mounts(svc appliedService, source, target string) bool {
	for _, v := range svc.Volumes {
		if v["type"] == "bind" && v["source"] == source && v["target"] == target && v["read_only"] == true {
			return true
		}
	}
	return false
}

// A service of a claim with org secrets: the bundle and the cell CA bound
// read-only, every variable pointing at them, over what the file set (its
// environment as a mapping or as a list).
func TestAServiceOfAClaimWithSecretsTrustsTheCellCA(t *testing.T) {
	o := opts(checkout(t))
	o.Trust = trustFiles
	svcs := applied(t, `services:
  api:
    image: img-a
    environment:
      SSL_CERT_FILE: /app/certs.pem
      DATABASE_URL: postgres://db/app
  worker:
    image: img-b
    environment: ["NODE_EXTRA_CA_CERTS=/app/ca.pem", "QUEUE=jobs"]
  db:
    image: img-c
`, o)
	for name, svc := range svcs {
		if !mounts(svc, trustFiles.Bundle, machinetrust.BundleTarget) || !mounts(svc, trustFiles.CellCA, machinetrust.CellCATarget) {
			t.Errorf("%s: the trust files are not mounted read-only: %v", name, svc.Volumes)
		}
		for k, v := range machinetrust.Env(machinetrust.BundleTarget, machinetrust.CellCATarget) {
			if svc.Environment[k] != v {
				t.Errorf("%s: %s = %v, want %s", name, k, svc.Environment[k], v)
			}
		}
	}
	if svcs["api"].Environment["DATABASE_URL"] != "postgres://db/app" || svcs["worker"].Environment["QUEUE"] != "jobs" {
		t.Errorf("the app's own env is gone: %v %v", svcs["api"].Environment, svcs["worker"].Environment)
	}
}

func TestAServiceOfAClaimWithoutSecretsGetsNoCellCA(t *testing.T) {
	svcs := applied(t, "services:\n  api:\n    image: img-a\n    environment:\n      SSL_CERT_FILE: /app/certs.pem\n", opts(checkout(t)))
	api := svcs["api"]
	for _, v := range api.Volumes {
		if tgt, _ := v["target"].(string); strings.HasPrefix(tgt, machinetrust.Dir) {
			t.Errorf("mounted %v", v)
		}
	}
	if len(api.Environment) != 1 || api.Environment["SSL_CERT_FILE"] != "/app/certs.pem" {
		t.Errorf("environment %v: the file's own trust changed", api.Environment)
	}
}

// Nothing of the checkout mounts where the cell's trust files go, with or
// without secrets.
func TestAComposeFileCannotMountUnderTheCellsTrustDirectory(t *testing.T) {
	dir := checkout(t)
	for _, target := range []string{machinetrust.BundleTarget, machinetrust.CellCATarget, machinetrust.Dir, machinetrust.Dir + "/other"} {
		for _, trust := range []bool{false, true} {
			o := opts(dir)
			if trust {
				o.Trust = trustFiles
			}
			var re *RefusedError
			if _, err := Apply([]byte("services:\n  api:\n    image: img-a\n    volumes: [\"./src:"+target+"\"]\n"), o); !errors.As(err, &re) {
				t.Errorf("a mount at %s (trust %v): %v", target, trust, err)
			}
		}
	}
}

// What compose would run must bind the cell's trust files and carry the
// cell's variables; the files bound elsewhere, a variable changed, or
// something else under the trust directory is refused.
func TestVerifyCanonicalWantsTheTrustFiles(t *testing.T) {
	o := opts(checkout(t))
	o.Trust = trustFiles
	binds := `{"type":"bind","source":"` + trustFiles.Bundle + `","target":"` + machinetrust.BundleTarget + `","read_only":true},` +
		`{"type":"bind","source":"` + trustFiles.CellCA + `","target":"` + machinetrust.CellCATarget + `","read_only":true}`
	env := `"environment":{"SSL_CERT_FILE":"` + machinetrust.BundleTarget + `","REQUESTS_CA_BUNDLE":"` + machinetrust.BundleTarget +
		`","CURL_CA_BUNDLE":"` + machinetrust.BundleTarget + `","GIT_SSL_CAINFO":"` + machinetrust.BundleTarget + `","NODE_EXTRA_CA_CERTS":"` + machinetrust.CellCATarget + `"},`
	ok := strings.Replace(canonical(binds), `"image":"x",`, `"image":"x",`+env, 1)
	if err := VerifyCanonical([]byte(ok), o); err != nil {
		t.Fatal(err)
	}
	var re *RefusedError
	for name, doc := range map[string]string{
		"no trust files":      strings.Replace(canonical(`{"type":"volume","source":"data","target":"/d"}`), `"image":"x",`, `"image":"x",`+env, 1),
		"no env":              canonical(binds),
		"a variable replaced": strings.Replace(ok, `"SSL_CERT_FILE":"`+machinetrust.BundleTarget, `"SSL_CERT_FILE":"/app/certs.pem`, 1),
		"bundle moved":        strings.Replace(ok, `"target":"`+machinetrust.BundleTarget, `"target":"/etc/ssl/x.pem`, 1),
		"another mount there": strings.Replace(ok, binds, binds+`,{"type":"volume","source":"data","target":"`+machinetrust.Dir+`/x"}`, 1),
	} {
		if err := VerifyCanonical([]byte(doc), o); !errors.As(err, &re) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
	// Without secrets the same trust directory is still the cell's.
	plain := opts(checkout(t))
	if err := VerifyCanonical([]byte(canonical(binds)), plain); !errors.As(err, &re) {
		t.Errorf("trust binds on a claim without secrets accepted: %v", err)
	}
}
