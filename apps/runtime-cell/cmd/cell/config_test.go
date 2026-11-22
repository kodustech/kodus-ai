package main

import (
	"encoding/json"
	"flag"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

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
	for _, args := range [][]string{{}, {"-driver", "fake"}, {"-driver", "aws-ec2", "-observer", "http"}, {"-driver", "k8s-sandbox"}} {
		if _, err := startOn(t, "", args...); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	for _, args := range [][]string{{"-driver", "fake", "-dev"}, {"-driver", "fake", "-dev", "-observer", "http"}} {
		if _, err := startOn(t, "", args...); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
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
	args := []string{"-driver", "docker-gvisor", "-isolation-backend", "gvisor", "-observer", "http", "-gvisor-observer-image", "observer@sha256:2222222222222222222222222222222222222222222222222222222222222222"}
	if _, err := startOn(t, "", args...); err == nil || !strings.Contains(err.Error(), "-gvisor-holder-image") {
		t.Fatalf("docker-gvisor without a holder image: %v", err)
	}
	if _, err := startOn(t, "", append(args, "-gvisor-holder-image", "holder@sha256:1111111111111111111111111111111111111111111111111111111111111111")...); err != nil {
		t.Fatal(err)
	}
}

// Probes need a real observer machine: http observers on docker-gvisor run
// its image, and in-process observers are for the fake and local-docker cells.
func TestDockerGVisorHTTPObserversNeedTheObserverImage(t *testing.T) {
	args := []string{"-driver", "docker-gvisor", "-isolation-backend", "gvisor", "-gvisor-holder-image", "holder@sha256:1111111111111111111111111111111111111111111111111111111111111111", "-observer", "http"}
	if _, err := startOn(t, "", args...); err == nil {
		t.Fatal("http observers without an observer image")
	}
	if _, err := startOn(t, "", append(args, "-gvisor-observer-image", "observer@sha256:2222222222222222222222222222222222222222222222222222222222222222")...); err != nil {
		t.Fatal(err)
	}
	if _, err := startOn(t, "", "-driver", "docker-gvisor", "-isolation-backend", "gvisor", "-gvisor-holder-image", "holder@sha256:1111111111111111111111111111111111111111111111111111111111111111"); err == nil {
		t.Fatal("in-process observers on docker-gvisor")
	}
	if _, err := startOn(t, "", "-driver", "local-docker", "-dev-insecure-local-docker", "-observer", "http"); err == nil {
		t.Fatal("http observers on local-docker, which has no observer machine")
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
	gv := []string{"-driver", "docker-gvisor", "-isolation-backend", "gvisor", "-gvisor-holder-image", "h@sha256:1111111111111111111111111111111111111111111111111111111111111111", "-observer", "http", "-gvisor-observer-image", "o@sha256:2222222222222222222222222222222222222222222222222222222222222222"}
	if _, err := startOn(t, "", append(gv, "-gvisor-browser-image", "browser@sha256:abc0000000000000000000000000000000000000000000000000000000000000", "-browser-explore")...); err != nil {
		t.Fatalf("explicit local browser exploration: %v", err)
	}
	for _, args := range [][]string{
		{"-driver", "fake", "-dev", "-observer", "http", "-gvisor-browser-image", "browser@sha256:abc0000000000000000000000000000000000000000000000000000000000000", "-browser-explore"},
		{"-driver", "local-docker", "-dev-insecure-local-docker", "-gvisor-browser-image", "browser@sha256:abc0000000000000000000000000000000000000000000000000000000000000", "-browser-explore"},
		append(gv, "-browser-explore"),
	} {
		if _, err := startOn(t, "", args...); err == nil {
			t.Fatal("exploration accepted without its isolated local runner")
		}
	}
}

// A cell nobody registered (a managed cell, certificate issued out of band)
// is kodus's; -owner names it explicitly and anything else is refused.
func TestOwnerIsKodusUnlessRegisteredOrNamed(t *testing.T) {
	cert := filepath.Join(t.TempDir(), "cert.pem")
	if s, err := parse(t, "-cert", cert, "-driver", "fake"); err != nil || s.Owner != "kodus" {
		t.Fatalf("owner %q, %v", s.Owner, err)
	}
	if s, err := parse(t, "-cert", cert, "-owner", "customer", "-driver", "fake"); err != nil || s.Owner != "customer" {
		t.Fatalf("owner %q, %v", s.Owner, err)
	}
	if _, err := parse(t, "-cert", cert, "-owner", "someone", "-driver", "fake"); err == nil {
		t.Fatal("an unknown owner was accepted")
	}
}

// The cell's own builder trusts the cell CA under any name of its digest; a
// stock BuildKit does not unless the operator says the image is a build of
// builder-image/.
func TestOnlyTheCellsOwnBuilderTrustsTheCellCA(t *testing.T) {
	_, digest, _ := strings.Cut(defaultBuilderImage, "@")
	for _, tc := range []struct {
		image    string
		operator bool
		want     bool
	}{
		{defaultBuilderImage, false, true},
		{"localhost:5000/kodus-runtime-builder@" + digest, false, true},
		{"moby/buildkit:v0.34.0-rootless@sha256:65eca3c01cd1180c8f64565c4e3c5983af5145818b0e6fa863385d099eb73855", false, false},
		{"kodus-runtime-builder:local", true, true},
		{"", false, false},
	} {
		if got := builderTrustsCellCA(tc.image, tc.operator); got != tc.want {
			t.Errorf("builderTrustsCellCA(%q, %v) = %v", tc.image, tc.operator, got)
		}
	}
}

func writeConfig(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// Every flag the cell registers, but -config and the insecure local-docker
// gate, can be set from the config file under its own name.
func TestEveryRegisteredFlagCanBeSetFromTheConfigFile(t *testing.T) {
	var s settings
	fs := flag.NewFlagSet("cell", flag.ContinueOnError)
	s.register(fs)
	file := map[string]any{}
	want := map[string]string{}
	fs.VisitAll(func(f *flag.Flag) {
		if fileOnlyByFlag[f.Name] {
			return
		}
		switch v := f.Value.(flag.Getter).Get().(type) {
		case bool:
			file[f.Name], want[f.Name] = !v, strconv.FormatBool(!v)
		case int:
			file[f.Name], want[f.Name] = v+3, strconv.Itoa(v+3)
		case time.Duration:
			file[f.Name], want[f.Name] = "3s", "3s"
		case string:
			file[f.Name], want[f.Name] = "from-file-"+f.Name, "from-file-"+f.Name
		default:
			t.Fatalf("-%s: a flag kind the test does not know (%T)", f.Name, v)
		}
	})
	b, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	set := map[string]bool{}
	if err := applyFile(fs, writeConfig(t, "cell.json", string(b)), set); err != nil {
		t.Fatal(err)
	}
	if len(want) < 90 {
		t.Fatalf("only %d flags", len(want))
	}
	for name, v := range want {
		if got := fs.Lookup(name).Value.String(); got != v || !set[name] {
			t.Errorf("-%s: %q (set %v), want %q", name, got, set[name], v)
		}
	}
}

// A setting reads the same from the command line and from the file, for
// each kind of flag; a list in the file is a comma-separated flag.
func TestFileAndFlagGiveTheSameSettings(t *testing.T) {
	for _, tc := range []struct {
		name, flag, value, yaml string
	}{
		{name: "bool", flag: "gvisor-golden-data", value: "false", yaml: "gvisor-golden-data: false"},
		{name: "int", flag: "gvisor-cpus-max", value: "6", yaml: "gvisor-cpus-max: 6"},
		{name: "duration", flag: "gvisor-health-start-interval", value: "500ms", yaml: "gvisor-health-start-interval: 500ms"},
		{name: "string", flag: "gvisor-mem-limit", value: "8g", yaml: "gvisor-mem-limit: 8g"},
		{name: "string list", flag: "egress-allow", value: "a.example,b.example", yaml: "egress-allow: [a.example, b.example]"},
		{name: "first format", flag: "regions", value: "us-east-1,eu-west-1", yaml: "regions: [us-east-1, eu-west-1]"},
		{name: "first format section", flag: "ca", value: "/tmp/ca.pem", yaml: "tls:\n  ca: /tmp/ca.pem"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			byFlag, err := parse(t, "-"+tc.flag+"="+tc.value)
			if err != nil {
				t.Fatal(err)
			}
			byFile, err := parse(t, "-config", writeConfig(t, "cell.yaml", tc.yaml+"\n"))
			if err != nil {
				t.Fatal(err)
			}
			if !byFile.explicit[tc.flag] {
				t.Fatalf("-%s from the file is not explicit", tc.flag)
			}
			byFlag.Config, byFile.Config, byFlag.explicit, byFile.explicit = "", "", nil, nil
			if !reflect.DeepEqual(byFlag, byFile) {
				t.Fatalf("flag %+v\nfile %+v", byFlag, byFile)
			}
		})
	}
}

// A key that names no flag the file may set is refused, by its name.
func TestAnUnknownKeyInTheFileIsRefused(t *testing.T) {
	for _, body := range []string{
		"gvisor-mem-limt: 8g\n", "tls:\n  issuerr: /tmp/i.pem\n", "dev-insecure-local-docker: true\n", "config: other.yaml\n",
	} {
		key := strings.TrimSpace(strings.Split(strings.Split(body, "\n")[0], ":")[0])
		if key == "tls" {
			key = "tls.issuerr"
		}
		_, err := parse(t, "-config", writeConfig(t, "cell.yaml", body))
		if err == nil || !strings.Contains(err.Error(), key) {
			t.Errorf("%q: %v", body, err)
		}
	}
	_, err := parse(t, "-config", writeConfig(t, "cell.yaml", "hubUrl: wss://a/v1/cell\nhub-url: wss://b/v1/cell\n"))
	if err == nil || !strings.Contains(err.Error(), "-hub-url") {
		t.Errorf("one flag set twice: %v", err)
	}
}

// A driver flag set in the file is refused on a driver that does not read
// it, as on the command line, and the command line still wins over the file.
func TestAValueFromTheFileCountsAsExplicitlySetForFlagOwnership(t *testing.T) {
	p := writeConfig(t, "cell.yaml", "driver: docker-gvisor\nobserver: http\ngvisor-mem-limit: 8g\n")
	if _, err := startOn(t, "", "-config", p, "-isolation-backend", "firecracker"); err == nil || !strings.Contains(err.Error(), "-gvisor-mem-limit") {
		t.Fatalf("a file's docker-gvisor flag on firecracker: %v", err)
	}
	s, err := parse(t, "-config", p, "-gvisor-mem-limit", "2g")
	if err != nil || s.GVisorMemLimit != "2g" {
		t.Fatalf("flag over file: %q %v", s.GVisorMemLimit, err)
	}
}

// Exercised lines are on unless the operator turns them off (each claim's
// coverage directory is a capped tmpfs, coverage.Tmpfs), by flag or by the
// config file.
func TestExercisedLinesIsOnByDefaultAndTurnsOff(t *testing.T) {
	st, err := parse(t)
	if err != nil {
		t.Fatal(err)
	}
	if !st.ExercisedLines {
		t.Fatal("exercised lines are off by default")
	}
	if st, err = parse(t, "-exercised-lines"); err != nil || !st.ExercisedLines {
		t.Fatalf("-exercised-lines: %v, on=%v", err, st.ExercisedLines)
	}
	if st, err = parse(t, "-config", writeConfig(t, "cell.yaml", "exercised-lines: true\n")); err != nil || !st.ExercisedLines {
		t.Fatalf("the file's exercised-lines: true: %v, on=%v", err, st.ExercisedLines)
	}
	if st, err = parse(t, "-exercised-lines=false"); err != nil || st.ExercisedLines {
		t.Fatalf("-exercised-lines=false: %v, on=%v", err, st.ExercisedLines)
	}
	if st, err = parse(t, "-config", writeConfig(t, "cell.yaml", "exercised-lines: false\n")); err != nil || st.ExercisedLines {
		t.Fatalf("the file's exercised-lines: false: %v, on=%v", err, st.ExercisedLines)
	}
}

// The warm fork reset is off unless asked, and only docker-gvisor takes it.
func TestWarmForkResetIsOffByDefaultAndDockerGVisorsAlone(t *testing.T) {
	st, err := parse(t)
	if err != nil || st.GVisorWarmForkReset {
		t.Fatalf("default: %v, on=%v", err, st.GVisorWarmForkReset)
	}
	if st, err = parse(t, "-gvisor-warm-fork-reset"); err != nil || !st.GVisorWarmForkReset {
		t.Fatalf("-gvisor-warm-fork-reset: %v, on=%v", err, st.GVisorWarmForkReset)
	}
	if st, err = parse(t, "-config", writeConfig(t, "cell.yaml", "gvisor-warm-fork-reset: true\n")); err != nil || !st.GVisorWarmForkReset {
		t.Fatalf("the file's gvisor-warm-fork-reset: %v, on=%v", err, st.GVisorWarmForkReset)
	}
	if _, err := startOn(t, "", "-driver", "fake", "-dev", "-gvisor-warm-fork-reset"); err == nil {
		t.Fatal("fake took -gvisor-warm-fork-reset")
	}
}

// Tool layers are off unless asked, need the sandbox image they are built
// for, take limits that nest, and only docker-gvisor reads the flags.
func TestToolLayersAreOffByDefaultNeedTheSandboxImageAndTakeNestedLimits(t *testing.T) {
	st, err := parse(t)
	if err != nil || st.GVisorToolLayer || st.GVisorToolLayerMaxMB != 256 || st.GVisorToolLayerOrgGB != 2 || st.GVisorToolLayerBudgetGB != 20 {
		t.Fatalf("default: %v, %+v", err, st)
	}
	cfg := toolLayerConfig(st)
	if cfg.Enabled || cfg.MaxLayerBytes != 256<<20 || cfg.MaxOrgBytes != 2<<30 || cfg.MaxCellBytes != 20<<30 {
		t.Fatalf("config %+v", cfg)
	}
	img := "s@sha256:" + strings.Repeat("3", 64)
	if st, err = parse(t, "-gvisor-toollayer", "-gvisor-sandbox-image", img, "-gvisor-toollayer-max-mb", "64", "-gvisor-toollayer-org-gb", "1", "-gvisor-toollayer-budget-gb", "4"); err != nil || !st.GVisorToolLayer {
		t.Fatalf("on: %v", err)
	}
	if err := validateToolLayers(st); err != nil {
		t.Fatalf("valid limits: %v", err)
	}
	for name, edit := range map[string]func(*settings){
		"no sandbox image": func(s *settings) { s.Sandbox.Image = "" },
		"zero":             func(s *settings) { s.GVisorToolLayerMaxMB = 0 },
		"layer over org":   func(s *settings) { s.GVisorToolLayerMaxMB = 2048 },
		"org over cell":    func(s *settings) { s.GVisorToolLayerOrgGB = 8 },
	} {
		bad := st
		edit(&bad)
		if err := validateToolLayers(bad); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := startOn(t, "", "-driver", "fake", "-dev", "-gvisor-toollayer"); err == nil {
		t.Fatal("fake took -gvisor-toollayer")
	}
}
