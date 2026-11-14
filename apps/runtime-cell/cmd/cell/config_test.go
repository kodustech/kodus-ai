package main

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

func parse(t *testing.T, args ...string) (settings, error) {
	t.Helper()
	fs := flag.NewFlagSet("cell", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return parseSettings(fs, args)
}

// The active-step limit must be explicitly configurable and validated.
func TestClaimStepLimitFlagAcceptsABoundedPositiveValue(t *testing.T) {
	if _, err := parse(t, "-max-claim-steps", "8"); err != nil {
		t.Fatal(err)
	}
}

func TestClaimStepLimitConfigurationPrecedenceAndValidation(t *testing.T) {
	const env = "KODUS_CELL_MAX_CLAIM_STEPS"
	t.Setenv(env, "")
	if err := os.Unsetenv(env); err != nil {
		t.Fatal(err)
	}
	if s, err := parse(t); err != nil || s.MaxClaimSteps != 4 {
		t.Fatalf("default: %d %v", s.MaxClaimSteps, err)
	}
	for _, value := range []string{"1", "8", "64"} {
		t.Setenv(env, value)
		if s, err := parse(t); err != nil || s.MaxClaimSteps == 4 {
			t.Fatalf("env %s: %d %v", value, s.MaxClaimSteps, err)
		}
	}
	for _, value := range []string{"", "0", "-1", "65", "1.5", "bad"} {
		t.Setenv(env, value)
		if _, err := parse(t); err == nil {
			t.Fatalf("accepted env %q", value)
		}
	}
	t.Setenv(env, "bad")
	path := filepath.Join(t.TempDir(), "cell.yaml")
	if err := os.WriteFile(path, []byte("maxClaimSteps: 8\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if s, err := parse(t, "-config", path); err != nil || s.MaxClaimSteps != 8 {
		t.Fatalf("file over env: %d %v", s.MaxClaimSteps, err)
	}
	if s, err := parse(t, "-config", path, "-max-claim-steps", "1"); err != nil || s.MaxClaimSteps != 1 {
		t.Fatalf("flag over file/env: %d %v", s.MaxClaimSteps, err)
	}
	for _, value := range []string{"0", "-1", "65"} {
		if _, err := parse(t, "-max-claim-steps", value); err == nil {
			t.Fatalf("accepted flag %q", value)
		}
		if err := os.WriteFile(path, []byte("maxClaimSteps: "+value+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := parse(t, "-config", path); err == nil {
			t.Fatalf("accepted file %q", value)
		}
	}
}

func TestExampleConfigLoadsAndFlagsWin(t *testing.T) {
	ex := filepath.Join("..", "..", "deploy", "local-docker.example.json")
	s, err := parse(t, "-config", ex, "-cell-id", "from-flag", "-dev=false")
	if err != nil {
		t.Fatal(err)
	}
	if s.Driver != "local-docker" || s.HubURL == "" || s.ObsMode != "inprocess" || s.StateDir == "" || s.CA == "" {
		t.Fatalf("file not applied: %+v", s)
	}
	if s.CellID != "from-flag" || s.Dev {
		t.Fatalf("flags must override the file: %+v", s)
	}
	if s.DevInsecureLocalDocker {
		t.Fatal("the insecure gate never comes from the file")
	}
}

func TestYAMLConfigAndUnknownFields(t *testing.T) {
	dir := t.TempDir()
	y := filepath.Join(dir, "cell.yaml")
	if err := os.WriteFile(y, []byte("cellId: c-yaml\ndriver: fake\ndev: true\ntls:\n  ca: /tmp/ca.pem\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := parse(t, "-config", y, "-workdir", dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.CellID != "c-yaml" || !s.Dev || s.CA != "/tmp/ca.pem" || s.StateDir != filepath.Join(dir, "state") {
		t.Fatalf("yaml %+v", s)
	}
	j := filepath.Join(dir, "cell.json")
	if err := os.WriteFile(j, []byte(`{"cellId":"x","devInsecureLocalDocker":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := parse(t, "-config", j); err == nil {
		t.Fatal("unknown field accepted (the insecure gate must not be settable from the file)")
	}
}

// M14: no driver is a default, and the fake one needs -dev.
func TestDriverGate(t *testing.T) {
	env := func(string) string { return "" }
	if err := checkDriverGate(settings{}, env); err == nil {
		t.Fatal("no -driver accepted")
	}
	if err := checkDriverGate(settings{Driver: "fake"}, env); err == nil {
		t.Fatal("fake driver without -dev")
	}
	if err := checkDriverGate(settings{Driver: "fake", Dev: true}, env); err != nil {
		t.Fatal(err)
	}
	if err := checkDriverGate(settings{Driver: "aws-ec2"}, env); err != nil {
		t.Fatal(err)
	}
}

// M15: the cell id is the certificate's CN; a configured one must agree.
func TestCellIDIsTheCertificateCN(t *testing.T) {
	if id, err := resolveCellID("", "cell-7"); err != nil || id != "cell-7" {
		t.Fatalf("%q %v", id, err)
	}
	if _, err := resolveCellID("cell-8", "cell-7"); err == nil {
		t.Fatal("a -cell-id that is not the CN")
	}
}

func TestObserverConfigNamesItsClaim(t *testing.T) {
	c := agent.ClaimInfo{ClaimID: "claim-1", Workload: driver.MachineRef{ImageID: "img-1"}}
	if got := observerConfig(c, nil); got.ClaimID != "claim-1" || got.ImageID != "img-1" {
		t.Fatalf("%+v", got)
	}
}

func TestDockerGVisorNeedsItsHolderImage(t *testing.T) {
	env := func(string) string { return "" }
	if err := checkDriverGate(settings{Driver: "docker-gvisor"}, env); err == nil {
		t.Fatal("docker-gvisor without a holder image")
	}
	if err := checkDriverGate(settings{Driver: "docker-gvisor", GVisorHolderImage: "holder@sha256:x"}, env); err != nil {
		t.Fatal(err)
	}
}

// Probes need a real observer machine: http observers on docker-gvisor run its image.
func TestDockerGVisorHTTPObserversNeedTheObserverImage(t *testing.T) {
	env := func(string) string { return "" }
	s := settings{Driver: "docker-gvisor", GVisorHolderImage: "holder@sha256:x", ObsMode: "http"}
	if err := checkDriverGate(s, env); err == nil {
		t.Fatal("http observers without an observer image")
	}
	s.GVisorObserverImage = "observer@sha256:y"
	if err := checkDriverGate(s, env); err != nil {
		t.Fatal(err)
	}
}

// Old replay images do not imply native exploration support.
func TestBrowserExplorationIsExplicitAndOffByDefault(t *testing.T) {
	var s settings
	fs := flag.NewFlagSet("cell", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	s.register(fs)
	f := fs.Lookup("browser-explore")
	if f == nil || f.DefValue != "false" {
		t.Fatal("local browser exploration must be registered and disabled by default")
	}
	if _, err := parse(t, "-driver", "docker-gvisor", "-gvisor-browser-image", "browser@sha256:abc", "-browser-explore"); err != nil {
		t.Fatalf("explicit local browser exploration: %v", err)
	}
	for _, args := range [][]string{
		{"-driver", "aws-ec2", "-gvisor-browser-image", "browser@sha256:abc", "-browser-explore"},
		{"-driver", "local-docker", "-gvisor-browser-image", "browser@sha256:abc", "-browser-explore"},
		{"-driver", "docker-gvisor", "-browser-explore"},
	} {
		if _, err := parse(t, args...); err == nil {
			t.Fatal("exploration accepted without its isolated local runner")
		}
	}
}
