package sandbox

import (
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
)

const healthy = `
services:
  db:
    image: postgres:16
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready']
      interval: 2s
      retries: 30
  app:
    image: app
    healthcheck:
      test: curl -f http://127.0.0.1/health
  slow:
    image: app
    healthcheck:
      test: ['CMD', 'true']
      interval: 1s
      retries: 3
  own:
    image: app
    healthcheck:
      test: ['CMD', 'true']
      interval: 5s
      start_period: 1m
  off:
    image: app
    healthcheck:
      disable: true
  none:
    image: app
    healthcheck:
      test: ['NONE']
  inherited:
    image: app
    healthcheck:
      interval: 5s
  odd:
    image: app
    healthcheck:
      test: ['CMD', 'true']
      interval: 1d
  fast:
    image: app
    healthcheck:
      test: ['CMD', 'true']
      interval: 100ms
  bare:
    image: app
`

func healthOf(t *testing.T, every time.Duration) map[string]map[string]any {
	t.Helper()
	o := opts(t.TempDir())
	o.HealthStartInterval = every
	out, err := Apply([]byte(healthy), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Services map[string]struct {
			Healthcheck map[string]any `yaml:"healthcheck"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	hc := map[string]map[string]any{}
	for name, s := range doc.Services {
		hc[name] = s.Healthcheck
	}
	return hc
}

// A starting service is probed at the cell's cadence until its first pass,
// for at most its own budget (interval × retries, Docker's defaults when
// unsaid) and never past maxFastStart; the probe and every key the file
// sets stay as written.
func TestFastStartHealthProbesAStartingServiceOften(t *testing.T) {
	hc := healthOf(t, 200*time.Millisecond)
	for name, want := range map[string]string{"db": "30s", "app": "30s", "slow": "3s"} {
		if hc[name]["start_interval"] != "200ms" || hc[name]["start_period"] != want {
			t.Errorf("%s: %v, want start_interval 200ms and start_period %s", name, hc[name], want)
		}
	}
	if hc["db"]["interval"] != "2s" || hc["db"]["retries"] != 30 || hc["db"]["test"] == nil {
		t.Errorf("db's own healthcheck changed: %v", hc["db"])
	}
	// What the file decided itself, a healthcheck that is off, one with no
	// test of its own (the image's), an interval the cell does not read, or
	// one already faster: as written.
	for _, name := range []string{"own", "off", "none", "inherited", "odd", "fast"} {
		if _, ok := hc[name]["start_interval"]; ok {
			t.Errorf("%s rewritten: %v", name, hc[name])
		}
	}
	if hc["own"]["start_period"] != "1m" {
		t.Errorf("own start_period: %v", hc["own"])
	}
	if hc["bare"] != nil {
		t.Errorf("a service with no healthcheck got one: %v", hc["bare"])
	}
}

func TestFastStartHealthOffLeavesHealthchecksAsWritten(t *testing.T) {
	for name, h := range healthOf(t, 0) {
		if _, ok := h["start_interval"]; ok {
			t.Errorf("%s rewritten with the option off: %v", name, h)
		}
	}
}
