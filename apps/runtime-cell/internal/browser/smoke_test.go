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
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// The runner image against the sample app's orders page, main and the PR,
// through Capture: the real container, the real tar stream, the caps, the
// redaction and the Go pixel diff. It needs Docker, the image and the two
// apps already up on one internal network:
//
//	KBR_IMAGE=kodus/browser-runner@sha256:... KBR_NETWORK=kbr-net \
//	KBR_BASE_IP=192.168.0.4 KBR_PR_IP=192.168.0.5 KBR_OUT=/tmp/kbr-out \
//	go test -tags dockersmoke -run TestSmokeOrdersPage -v ./internal/browser/
//
// KBR_RUNTIME=runsc runs it under gVisor where the daemon has it.

// dockerRunner is the driver's argv (dockergvisor.browserArgs) for a
// network and an app address given by hand.
type dockerRunner struct{ image, network, runtime, ip string }

func (d dockerRunner) Run(ctx context.Context, spec RunSpec, job []byte, out io.Writer) error {
	name := fmt.Sprintf("kbr-runner-%d", time.Now().UnixNano())
	args := []string{"run", "--rm", "-i", "--name", name, "--network", d.network, "--add-host", AppHost + ":" + d.ip,
		"--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g", "--user", "10001:10001", "--cap-drop", "ALL",
		"--security-opt", "no-new-privileges:true", "--pids-limit", "512", "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--log-driver", "none"}
	if d.runtime != "" {
		args = append(args, "--runtime", d.runtime)
	}
	args = append(args, d.image)
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Stdin, cmd.Stdout = bytes.NewReader(job), out
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	_ = exec.Command("docker", "rm", "-f", name).Run()
	if err != nil {
		return fmt.Errorf("%w: %s", err, stderr.String())
	}
	return nil
}

func env(t *testing.T, k string) string {
	t.Helper()
	v := os.Getenv(k)
	if v == "" {
		t.Skipf("%s not set", k)
	}
	return v
}

func smokeProbe() protocol.BrowserProbe {
	return protocol.BrowserProbe{
		Kind: "browser",
		Steps: []protocol.BrowserStep{
			{Goto: ptr("/")},
			{WaitFor: ptr("body[data-state=ready]")},
			{Screenshot: ptr("orders")},
			{GetAttribute: []string{"#place", "type"}},
			{ExpectText: []string{"#orders", "keyboard"}},
		},
		Viewport:  protocol.BrowserProbeViewport{Width: 1280, Height: 720},
		Clock:     ptr("2030-01-01T00:00:00.000Z"),
		TimeoutMs: 30_000,
	}
}

func save(t *testing.T, dir string, o *Outcome, res protocol.ProbeResult) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, a := range o.Artifacts {
		ext := map[protocol.EvidenceContentType]string{"image/png": ".png", "video/webm": ".webm", "application/zip": ".zip", "application/json": ".json"}[a.ContentType]
		if err := os.WriteFile(filepath.Join(dir, string(a.Type)+ext), a.Body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, _ := json.MarshalIndent(res, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "probe-result.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func shotOf(o *Outcome, n string) []byte {
	for _, a := range o.Artifacts {
		if string(a.Type) == n {
			return a.Body
		}
	}
	return nil
}

func TestSmokeOrdersPage(t *testing.T) {
	image, network, out := env(t, "KBR_IMAGE"), env(t, "KBR_NETWORK"), env(t, "KBR_OUT")
	baseIP, prIP := env(t, "KBR_BASE_IP"), env(t, "KBR_PR_IP")
	r := redact.New(redact.Known{Label: "claim", Value: "shop"})
	round := func(side, ip string, baseline []protocol.BaselineScreenshot) (*Outcome, protocol.ProbeResult) {
		t0 := time.Now()
		c := Capture{Runner: dockerRunner{image: image, network: network, runtime: os.Getenv("KBR_RUNTIME"), ip: ip}, Redactor: r}
		o, err := c.Run(context.Background(), Request{Probe: smokeProbe(), Spec: RunSpec{ClaimID: "claim-smoke", Service: "app", Port: 3000}, Baseline: baseline, T0: t0})
		if err != nil {
			t.Fatalf("%s: %v", side, err)
		}
		res := protocol.ProbeResult{StepID: "0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d", Executor: "observer", ImageID: "sample-app", Transport: protocol.ProbeResultTransportOk,
			Browser: o.Browser, Requests: o.Requests, DurationMs: time.Since(t0).Milliseconds()}
		for _, d := range o.Dropped {
			t.Logf("%s dropped: %s", side, d)
		}
		save(t, filepath.Join(out, side), o, res)
		return o, res
	}
	base, _ := round("base", baseIP, nil)
	// The baseline the worker would sign: main's screenshot of step 2, served by a stand-in evidence store.
	shot := shotOf(base, "screenshot-0")
	if shot == nil {
		t.Fatal("main took no screenshot")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(shot)
	}))
	defer srv.Close()
	baseline := []protocol.BaselineScreenshot{{Step: 2, Screenshot: 0, URL: srv.URL + "/base/screenshot-0"}}
	base2, _ := round("base-2", baseIP, baseline)
	pr, _ := round("pr", prIP, baseline)

	for _, s := range base.Browser.Steps {
		if !s.Ok {
			t.Fatalf("main failed step %d: %+v", s.Index, s)
		}
	}
	if len(base2.Browser.Pixels) != 1 || base2.Browser.Pixels[0].Ratio > 0.001 {
		t.Fatalf("main against itself: %+v", base2.Browser.Pixels)
	}
	last := pr.Browser.Steps[4]
	if last.Ok || last.Error == nil || *last.Error != protocol.BrowserStepErrorMismatch {
		t.Fatalf("the PR's empty list was not caught: %+v", last)
	}
	if len(pr.Browser.Pixels) != 1 || pr.Browser.Pixels[0].Ratio <= 0.001 {
		t.Fatalf("the PR's screen did not change: %+v", pr.Browser.Pixels)
	}
	t.Logf("main vs main: %.5f of pixels; main vs PR: %.5f (%d of %d)", base2.Browser.Pixels[0].Ratio, pr.Browser.Pixels[0].Ratio, pr.Browser.Pixels[0].Changed, pr.Browser.Pixels[0].Total)
	for _, side := range []*Outcome{base, pr} {
		var types []string
		for _, a := range side.Artifacts {
			types = append(types, fmt.Sprintf("%s(%d)", a.Type, len(a.Body)))
		}
		t.Logf("artifacts: %v", types)
	}
}
