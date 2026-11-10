//go:build dockersmoke

package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// These are owned sample-app containers on a separate internal network. This
// exercises production Capture + the actual Chromium image, not a cloud Run,
// and does not establish gVisor enforcement on a macOS Docker daemon.
type modeSmokeRunner struct {
	image, network, runtime, ip, output, collector, socket string
}

func (d modeSmokeRunner) Run(ctx context.Context, _ RunSpec, job []byte, out io.Writer) error {
	name := fmt.Sprintf("kbr-modes-runner-%d", time.Now().UnixNano())
	args := []string{"run", "--rm", "-i", "--name", name, "--network", d.network,
		"--add-host", AppHost + ":" + d.ip, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g",
		"--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
		"--pids-limit", "512", "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--log-driver", "none"}
	if d.runtime != "" {
		args = append(args, "--runtime", d.runtime)
	}
	args = append(args, d.image)
	var collector *exec.Cmd
	if d.collector != "" && d.socket != "" {
		collector = exec.Command("python3", d.collector, "--socket", d.socket, "--container", name,
			"--duration", "120", "--interval", "0.2", "--timeout", "2", "--output", filepath.Join(d.output, "resources.jsonl"))
		if err := collector.Start(); err != nil {
			return fmt.Errorf("start passive collector: %w", err)
		}
		defer func() {
			_ = collector.Process.Signal(os.Interrupt)
			_ = collector.Wait()
		}()
	}
	cmd := exec.CommandContext(ctx, "docker", args...)
	var stderr bytes.Buffer
	cmd.Stdin, cmd.Stdout, cmd.Stderr = bytes.NewReader(job), out, &stderr
	if os.Getenv("KBR_RAW_RUNNER") == "1" {
		archive, err := os.Create(filepath.Join(d.output, "raw-runner.tar"))
		if err != nil {
			return err
		}
		defer archive.Close()
		cmd.Stdout = io.MultiWriter(out, archive)
	}
	err := cmd.Run()
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = exec.CommandContext(cleanup, "docker", "rm", "-f", name).Run()
	if err != nil {
		return fmt.Errorf("owned Chromium fixture: %w: %.512s", err, stderr.String())
	}
	return nil
}

func TestSmokeBrowserEvidenceModes(t *testing.T) {
	image, network, output := env(t, "KBR_IMAGE"), env(t, "KBR_NETWORK"), env(t, "KBR_OUT")
	baseIP, prIP := env(t, "KBR_BASE_IP"), env(t, "KBR_PR_IP")
	probe := smokeProbe()
	if err := os.MkdirAll(output, 0o755); err != nil {
		t.Fatal(err)
	}
	body, _ := json.MarshalIndent(probe, "", "  ")
	if err := os.WriteFile(filepath.Join(output, "probe.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	type measurement struct {
		Mode          protocol.EvidenceLevel `json:"mode"`
		Round         string                 `json:"round"`
		WallMs        int64                  `json:"wallMs"`
		ArtifactBytes int                    `json:"artifactBytes"`
		Types         []string               `json:"types"`
		Requests      int                    `json:"requests"`
	}
	var measured []measurement
	observations := map[string]map[string][]protocol.RequestLogEntry{}
	var sequence int
	modes := []protocol.EvidenceLevel{protocol.EvidenceLevelFull, protocol.EvidenceLevelLean}
	if os.Getenv("KBR_MODE_ORDER") == "lean-first" {
		modes = []protocol.EvidenceLevel{protocol.EvidenceLevelLean, protocol.EvidenceLevelFull}
	}
	for _, mode := range modes {
		mode := mode
		t.Run(string(mode), func(t *testing.T) {
			observations[string(mode)] = map[string][]protocol.RequestLogEntry{}
			var baseline []protocol.BaselineScreenshot
			var baselineServer *httptest.Server
			defer func() {
				if baselineServer != nil {
					baselineServer.Close()
				}
			}()
			for _, round := range []string{"base-1", "base-2", "control-1", "pr-1", "pr-2"} {
				ip := baseIP
				if round[:2] == "pr" {
					ip = prIP
				}
				dir := filepath.Join(output, string(mode), round)
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				runner := modeSmokeRunner{image: image, network: network, runtime: os.Getenv("KBR_RUNTIME"), ip: ip,
					output: dir, collector: os.Getenv("KBR_COLLECTOR"), socket: os.Getenv("KBR_DOCKER_SOCKET")}
				capture := Capture{Runner: runner, Redactor: redact.New()}
				started := time.Now()
				out, err := capture.Run(context.Background(), Request{Probe: probe, Evidence: &mode,
					Spec: RunSpec{ClaimID: "claim-mode-smoke", Service: "app", Port: 3000}, Baseline: baseline, T0: started})
				if err != nil {
					t.Fatalf("%s/%s: %v", mode, round, err)
				}
				wall := time.Since(started).Milliseconds()
				sequence++
				result := protocol.ProbeResult{StepID: fmt.Sprintf("00000000-0000-4000-8000-%012x", sequence), Executor: "observer", ImageID: "sample-app",
					Transport: protocol.ProbeResultTransportOk, Browser: out.Browser, Requests: out.Requests, DurationMs: wall}
				save(t, dir, out, result)
				m := measurement{Mode: mode, Round: round, WallMs: wall, Requests: len(out.Requests)}
				for _, artifact := range out.Artifacts {
					m.ArtifactBytes += len(artifact.Body)
					m.Types = append(m.Types, string(artifact.Type))
				}
				sort.Strings(m.Types)
				for _, kind := range []string{"video", "trace", "har"} {
					has := false
					for _, typ := range m.Types {
						has = has || typ == kind
					}
					if mode == protocol.EvidenceLevelLean && has {
						t.Fatalf("lean produced %s", kind)
					}
					if mode == protocol.EvidenceLevelFull && !has {
						t.Fatalf("full lost %s: %v", kind, out.Dropped)
					}
				}
				if len(out.Requests) == 0 {
					t.Fatal("browser request coverage is missing")
				}
				var routes []protocol.RequestLogEntry
				for _, r := range out.Requests {
					r.At = nil
					routes = append(routes, r)
				}
				sort.Slice(routes, func(i, j int) bool { return fmt.Sprint(routes[i]) < fmt.Sprint(routes[j]) })
				observations[string(mode)][round] = routes
				if round == "base-1" {
					for _, s := range out.Browser.Steps {
						if !s.Ok {
							t.Fatalf("main failed step %d", s.Index)
						}
					}
					shot := shotOf(out, "screenshot-0")
					if shot == nil {
						t.Fatal("main screenshot missing")
					}
					baselineServer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
						w.Header().Set("Content-Type", "image/png")
						_, _ = w.Write(shot)
					}))
					baseline = []protocol.BaselineScreenshot{{Step: 2, Screenshot: 0, URL: baselineServer.URL + "/screenshot-0"}}
				} else if len(out.Browser.Pixels) == 0 {
					t.Fatal("pixel measurement missing")
				} else if (round == "base-2" || round == "control-1") && out.Browser.Pixels[0].Ratio > 0.001 {
					t.Fatalf("main is not stable: %v", out.Browser.Pixels)
				} else if round[:2] == "pr" {
					last := out.Browser.Steps[4]
					if last.Ok || last.Error == nil || *last.Error != protocol.BrowserStepErrorMismatch {
						t.Fatalf("PR regression was missed: %+v", last)
					}
				}
				measured = append(measured, m)
				t.Logf("%s/%s: wall=%dms bytes=%d artifacts=%v", mode, round, wall, m.ArtifactBytes, m.Types)
			}
		})
	}
	if t.Failed() {
		return
	}
	if !reflect.DeepEqual(observations["full"], observations["lean"]) {
		t.Fatalf("request coverage changed: %+v", observations)
	}
	var fullBytes, leanBytes int
	for _, m := range measured {
		if m.Mode == protocol.EvidenceLevelLean {
			leanBytes += m.ArtifactBytes
		} else {
			fullBytes += m.ArtifactBytes
		}
	}
	if leanBytes >= fullBytes {
		t.Fatalf("lean did not reduce artifact bytes: %d >= %d", leanBytes, fullBytes)
	}
	data, _ := json.MarshalIndent(measured, "", "  ")
	if err := os.WriteFile(filepath.Join(output, "measurements.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}
