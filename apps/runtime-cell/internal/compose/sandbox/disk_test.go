package sandbox

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

type diskService struct {
	Logging struct {
		Driver  string         `yaml:"driver"`
		Options map[string]any `yaml:"options"`
	} `yaml:"logging"`
	StorageOpt map[string]any `yaml:"storage_opt"`
}

func diskServices(t *testing.T, raw string, o Options) map[string]diskService {
	t.Helper()
	out, err := Apply([]byte(raw), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Services map[string]diskService `yaml:"services"`
	}
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Services
}

// Every service logs through the local driver within the cell's bound,
// whatever the file says: a service that sets max-size 1000g, or no logging
// at all, cannot fill the shared Docker disk with its logs (review #7). A
// smaller bound the file asks for is kept.
func TestEveryServiceLogsWithinTheCellsBound(t *testing.T) {
	svcs := diskServices(t, `services:
  noisy:
    image: a
    logging: { driver: json-file, options: { max-size: 1000g, max-file: "1000", mode: non-blocking, max-buffer-size: 10g } }
  silent:
    image: b
  modest:
    image: c
    logging: { options: { max-size: 1m, max-file: "2" } }
  odd:
    image: d
    logging: { options: { max-size: lots } }
`, opts(checkout(t)))
	want := map[string][2]string{"noisy": {"10m", "3"}, "silent": {"10m", "3"}, "modest": {"1m", "2"}, "odd": {"10m", "3"}}
	for name, w := range want {
		l := svcs[name].Logging
		if l.Driver != "local" || l.Options["max-size"] != w[0] || l.Options["max-file"] != w[1] || len(l.Options) != 2 {
			t.Errorf("%s logs %+v, want local %s x %s", name, l, w[0], w[1])
		}
	}
}

// The cell's own bound comes from its options.
func TestTheLogBoundIsTheCells(t *testing.T) {
	o := opts(checkout(t))
	o.LogMaxSize, o.LogMaxFile = "50m", 5
	l := diskServices(t, "services:\n  a:\n    image: x\n    logging: { options: { max-size: 1g } }\n", o)["a"].Logging
	if l.Driver != "local" || l.Options["max-size"] != "50m" || l.Options["max-file"] != "5" {
		t.Fatalf("logs %+v", l)
	}
}

// With a container disk size the cell caps every service's writable layer;
// without one, nothing is added (only some storage drivers take it).
func TestAContainerDiskSizeCapsEveryService(t *testing.T) {
	o := opts(checkout(t))
	if s := diskServices(t, "services:\n  a:\n    image: x\n", o)["a"]; s.StorageOpt != nil {
		t.Fatalf("storage_opt without a size: %v", s.StorageOpt)
	}
	o.DiskSize = "20G"
	if s := diskServices(t, "services:\n  a:\n    image: x\n", o)["a"]; s.StorageOpt["size"] != "20G" {
		t.Fatalf("storage_opt %v", s.StorageOpt)
	}
}

// The second reader holds the same: another log driver, a bound past the
// cell's, or a disk size other than the cell's is refused.
func TestVerifyCanonicalHoldsTheDiskBounds(t *testing.T) {
	dir := checkout(t)
	src, _ := filepath.EvalSymlinks(filepath.Join(dir, "src"))
	ok := canonical(`{"type":"bind","source":"` + src + `","target":"/app","read_only":true}`)
	ok = strings.Replace(ok, `"image":"x"`, `"image":"x","storage_opt":{"size":"20G"}`, 1)
	o := opts(dir)
	o.DiskSize = "20G"
	if err := VerifyCanonical([]byte(ok), o); err != nil {
		t.Fatal(err)
	}
	for name, cfg := range map[string]string{
		"syslog":      strings.Replace(ok, `"driver":"local"`, `"driver":"syslog"`, 1),
		"bigger logs": strings.Replace(ok, `"max-size":"10m"`, `"max-size":"1000g"`, 1),
		"more files":  strings.Replace(ok, `"max-file":"3"`, `"max-file":"1000"`, 1),
		"buffer":      strings.Replace(ok, `"max-file":"3"`, `"max-file":"3","max-buffer-size":"10g"`, 1),
		"bigger disk": strings.Replace(ok, `"size":"20G"`, `"size":"2000G"`, 1),
		"no disk":     strings.Replace(ok, `,"storage_opt":{"size":"20G"}`, ``, 1),
		"no logging":  strings.Replace(ok, `"logging":{"driver":"local","options":{"max-size":"10m","max-file":"3"}},`, ``, 1),
	} {
		var re *RefusedError
		if err := VerifyCanonical([]byte(cfg), o); !errors.As(err, &re) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
}
