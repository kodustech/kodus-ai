package dockergvisor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

type telemetryDocker struct {
	*memDocker
	loadErr      error
	loaded       bool
	artifact     func(string) error
	cancelOnLoad context.CancelFunc
}

func (m *telemetryDocker) RunBuild(ctx context.Context, b dockercli.BuildRun) error {
	if err := m.memDocker.RunBuild(ctx, b); err != nil {
		return err
	}
	if m.artifact != nil {
		return m.artifact(filepath.Join(b.Out, dockercli.BuildTarball))
	}
	return nil
}

func (m *telemetryDocker) LoadImage(context.Context, string) error {
	m.loaded = true
	if m.cancelOnLoad != nil {
		m.cancelOnLoad()
	}
	return m.loadErr
}

func buildEvents(t *testing.T, logs *bytes.Buffer, event string) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		if line == "" {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal([]byte(line), &fields); err != nil {
			t.Fatal(err)
		}
		if fields["msg"] == event {
			events = append(events, fields)
		}
	}
	return events
}

// Build and load failures used to return before build.timing, hiding the
// expensive attempts. Measuring them must preserve their errors and cleanup.
func TestBuildTimingIncludesFailedAndCanceledAttempts(t *testing.T) {
	compileErr, loadErr := errors.New("compile failed"), errors.New("load failed")
	for _, tc := range []struct {
		name, outcome                string
		buildErr, loadErr, wantErr   error
		cancel, cancelLoad, wantLoad bool
	}{
		{name: "success", outcome: "success", wantLoad: true},
		{name: "compile", outcome: "build_failed", buildErr: compileErr, wantErr: compileErr},
		{name: "oom", outcome: "out_of_memory", buildErr: &dockercli.ExitError{Code: dockercli.ExitKilled}, wantErr: driver.ErrOutOfMemory},
		{name: "cancel", outcome: "canceled", buildErr: context.Canceled, wantErr: context.Canceled, cancel: true},
		{name: "load", outcome: "load_failed", loadErr: loadErr, wantErr: loadErr, wantLoad: true},
		{name: "load_cancel", outcome: "canceled", loadErr: context.Canceled, wantErr: context.Canceled, cancelLoad: true, wantLoad: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, docker := bakeDriver(t)
			var logs bytes.Buffer
			d.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			docker.buildErr = tc.buildErr
			if tc.cancel {
				docker.duringBuild = func(dockercli.BuildRun) { cancel() }
			}
			wrapped := &telemetryDocker{memDocker: docker, loadErr: tc.loadErr}
			if tc.cancelLoad {
				wrapped.cancelOnLoad = cancel
			}
			d.d = wrapped
			ref := machine("claim-telemetry", bakeEnv)
			_, _, err := d.runBuild(ctx, ref, sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "test:claim", "net", "resolv", bakeSubnet)
			if !errors.Is(err, tc.wantErr) || wrapped.loaded != tc.wantLoad {
				t.Fatalf("err %v, loaded %v; want %v, %v", err, wrapped.loaded, tc.wantErr, tc.wantLoad)
			}
			events := buildEvents(t, &logs, "build.timing")
			if len(events) != 1 {
				t.Fatalf("got %d timing events: %s", len(events), logs.String())
			}
			event := events[0]
			if event["outcome"] != tc.outcome || event["loadAttempted"] != tc.wantLoad {
				t.Fatalf("timing: %v", event)
			}
			for _, key := range []string{"buildMs", "loadMs"} {
				if n, ok := event[key].(float64); !ok || n < 0 {
					t.Fatalf("missing/nonpositive duration %s: %v", key, event)
				}
			}
			if _, err := os.Stat(filepath.Join(d.workDir(), "builds", ref.MachineID, "api")); !os.IsNotExist(err) {
				t.Fatalf("build output survived cleanup: %v", err)
			}
		})
	}
}

// Artifact size was absent. Unknown metadata must stay unknown, and a
// symlink or directory from a builder must not be counted as image bytes.
func TestBuildTimingMeasuresOnlyRegularImageTarballs(t *testing.T) {
	for _, kind := range []string{"regular", "empty", "missing", "symlink", "directory", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			d, docker := bakeDriver(t)
			var logs bytes.Buffer
			d.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
			wrapped := &telemetryDocker{memDocker: docker, artifact: func(path string) error {
				if err := os.Remove(path); err != nil {
					return err
				}
				switch kind {
				case "regular":
					return os.WriteFile(path, []byte("image bytes"), 0o600)
				case "empty":
					return os.WriteFile(path, nil, 0o600)
				case "symlink":
					return os.Symlink(filepath.Join(project(t), "Dockerfile"), path)
				case "directory":
					return os.Mkdir(path, 0o700)
				case "fifo":
					return syscall.Mkfifo(path, 0o600)
				}
				return nil
			}}
			d.d = wrapped
			_, _, err := d.runBuild(context.Background(), machine("claim-bytes", bakeEnv), sandbox.Build{Service: "api", Context: project(t)}, "test:claim", "net", "resolv", bakeSubnet)
			if err != nil {
				t.Fatal(err)
			}
			events := buildEvents(t, &logs, "build.timing")
			if len(events) != 1 {
				t.Fatalf("timing events: %v", events)
			}
			got, present := events[0]["imageTarBytes"]
			if !present {
				t.Fatalf("missing byte measurement: %v", events[0])
			}
			switch kind {
			case "regular":
				if got != float64(len("image bytes")) {
					t.Fatalf("bytes: %v", got)
				}
			case "empty":
				if got != float64(0) {
					t.Fatalf("empty file bytes: %v", got)
				}
			default:
				if got != nil {
					t.Fatalf("nonregular/missing artifact counted: %v", got)
				}
			}
		})
	}
}

// A selected cache is an input, not a promised layer or compiler cache hit.
// The exported-cache and cold paths used to have no selection event.
func TestBuildLogsItsCacheInputMode(t *testing.T) {
	for _, mode := range []string{"cold", "exported", "state_seed", "state_overlay"} {
		t.Run(mode, func(t *testing.T) {
			d, _ := bakeDriver(t)
			ref := machine("claim-input", bakeEnv)
			if strings.HasPrefix(mode, "state_") {
				d, _, _ = statefulDriver(t)
				if mode == "state_seed" {
					asSetup(d, ref, true)
				} else {
					st, ok := d.states.Acquire(context.Background(), seed("claim-seed"))
					if !ok {
						t.Fatal("seed state unavailable")
					}
					d.states.Release(st)
				}
			}
			if mode == "exported" {
				setup := machine("claim-seed", bakeEnv)
				asSetup(d, setup, true)
				boot(t, d, setup, sandbox.Build{Service: "api", Context: project(t)})
			}
			var logs bytes.Buffer
			d.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
			_, _, err := d.runBuild(context.Background(), ref, sandbox.Build{Service: "api", Context: project(t)}, "test:claim", "net", "resolv", bakeSubnet)
			if err != nil {
				t.Fatal(err)
			}
			events := buildEvents(t, &logs, "build.cache.input")
			if len(events) != 1 || events[0]["mode"] != mode {
				t.Fatalf("cache input events: %v\n%s", events, logs.String())
			}
		})
	}
}

// Reuse used to mix a string and a boolean in one field. Source must
// distinguish a fresh build, the machine's image and an environment bake.
func TestBuildLogsAConsistentImageSource(t *testing.T) {
	d, _ := bakeDriver(t)
	var logs bytes.Buffer
	d.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	setup := machine("claim-setup", bakeEnv)
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	boot(t, d, setup, build)
	boot(t, d, setup, build)
	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	image, err := d.Bake(context.Background(), bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	base := machine("claim-base", bakeEnv)
	base.ImageID = image.ImageID
	boot(t, d, base, build)
	events := buildEvents(t, &logs, "build.done")
	if len(events) != 3 {
		t.Fatalf("build events: %v", events)
	}
	for i, source := range []string{"build", "machine", "environment"} {
		if events[i]["source"] != source || events[i]["reused"] != (i > 0) {
			t.Fatalf("image source %d: %v", i, events[i])
		}
	}
}
