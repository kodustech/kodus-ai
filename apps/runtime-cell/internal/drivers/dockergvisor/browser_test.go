package dockergvisor

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

const browserImage = "kodus/browser-runner@sha256:" + "2aa72c7971cca987809c0b820f6780eb039c6ff0ed639bba109eb0bb965012e8"

type browserCall struct {
	args  []string
	stdin string
}

func browserDriver(t *testing.T) (*Driver, *[]browserCall, func(ctx context.Context, args []string, stdin []byte, out io.Writer) error) {
	t.Helper()
	d, r, err := newDriver(t, `{"runsc":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	d.cfg.Runtime = "runsc"
	r.answers["ps"] = "c0ffee\n"
	d.mu.Lock()
	d.machineLocked("kodus-claim-1-workload").services = map[string]string{"app": "10.213.5.10", "db": "10.213.5.11"}
	d.mu.Unlock()
	var calls []browserCall
	exec := func(_ context.Context, args []string, stdin []byte, out io.Writer) error {
		calls = append(calls, browserCall{args: args, stdin: string(stdin)})
		if args[0] == "run" {
			_, _ = out.Write([]byte("tar"))
		}
		return nil
	}
	return d, &calls, exec
}

// The runner container is the design's: gVisor, the claim network only,
// its own user, a read-only root, no capability, bounded, the app by one
// name, the job on stdin, and a ceiling the sweep honors.
func TestBrowserRunnerStartsAnIsolatedContainerPerRound(t *testing.T) {
	d, calls, exec := browserDriver(t)
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	r := BrowserRunner{Driver: d, Image: browserImage, Exec: exec, Now: func() time.Time { return now }}
	var out strings.Builder
	err := r.Run(context.Background(), browser.RunSpec{ClaimID: "claim-1", Workload: "kodus-claim-1-workload", Service: "app", Port: 3000, Deadline: 100 * time.Second}, []byte(`{"steps":[]}`), &out)
	if err != nil {
		t.Fatal(err)
	}
	if out.String() != "tar" {
		t.Fatalf("stdout %q", out.String())
	}
	run := strings.Join((*calls)[0].args, " ")
	for _, want := range []string{
		"run --rm -i --name kodus-browser-claim-1-", "--runtime runsc", "--network kodus-claim-1",
		"--add-host app.kody.internal:10.213.5.10", "--read-only", "--tmpfs /tmp:rw,nosuid,nodev,size=1g",
		"--user 10001:10001", "--cap-drop ALL", "--security-opt no-new-privileges:true", "--pids-limit 512",
		"--memory 1g", "--memory-swap 1g", "--cpus 1", "--label kodus.cell=cell-1", "--label kodus.claim=claim-1",
		"--label kodus.hard-expires=2026-11-07T12:01:40Z", browserImage,
	} {
		if !strings.Contains(run, want) {
			t.Fatalf("runner argv lacks %q: %s", want, run)
		}
	}
	for _, never := range []string{"--privileged", "--network host", "--cap-add", "docker.sock", "-p "} {
		if strings.Contains(run, never) {
			t.Fatalf("runner argv has %q: %s", never, run)
		}
	}
	if (*calls)[0].stdin != `{"steps":[]}` {
		t.Fatalf("stdin %q", (*calls)[0].stdin)
	}
	// Removed after the round, whatever ended it.
	if last := (*calls)[len(*calls)-1].args; last[0] != "rm" || last[1] != "-f" || !strings.HasPrefix(last[2], "kodus-browser-claim-1-") {
		t.Fatalf("last call %v", last)
	}
}

func TestBrowserRunnerRefusesWhatItCannotRunSafely(t *testing.T) {
	d, _, exec := browserDriver(t)
	spec := browser.RunSpec{ClaimID: "claim-1", Workload: "kodus-claim-1-workload", Service: "app", Port: 3000, Deadline: time.Minute}
	if err := (BrowserRunner{Driver: d, Image: "kodus/browser-runner:latest", Exec: exec}).Run(context.Background(), spec, nil, io.Discard); err == nil {
		t.Fatal("an image not pinned by digest ran")
	}
	other := spec
	other.Service = "worker"
	if err := (BrowserRunner{Driver: d, Image: browserImage, Exec: exec}).Run(context.Background(), other, nil, io.Discard); err == nil {
		t.Fatal("a service the project did not bring up was targeted")
	}
	bad := spec
	bad.ClaimID = "../claim"
	if err := (BrowserRunner{Driver: d, Image: browserImage, Exec: exec}).Run(context.Background(), bad, nil, io.Discard); err == nil {
		t.Fatal("an invalid claim id was accepted")
	}
}

func TestBrowserRunnerMapsTheRunnersRefusal(t *testing.T) {
	d, _, _ := browserDriver(t)
	exec := func(_ context.Context, args []string, _ []byte, _ io.Writer) error {
		if args[0] == "run" {
			return &dockercli.ExitError{Command: "docker run", Code: exitJobRefused}
		}
		return nil
	}
	err := BrowserRunner{Driver: d, Image: browserImage, Exec: exec}.Run(context.Background(), browser.RunSpec{ClaimID: "claim-1", Workload: "kodus-claim-1-workload", Service: "app", Port: 3000, Deadline: time.Minute}, nil, io.Discard)
	if !errors.Is(err, browser.ErrJobRefused) {
		t.Fatalf("err %v", err)
	}
}

// A cancelled docker run used to start unbounded cleanup with WithoutCancel.
func TestBrowserCleanupSurvivesCancellationButHasFiniteDeadline(t *testing.T) {
	d, _, _ := browserDriver(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleaned := false
	run := func(call context.Context, args []string, _ []byte, _ io.Writer) error {
		if args[0] == "run" {
			cancel()
			return context.Canceled
		}
		cleaned = true
		if call.Err() != nil {
			t.Fatal("cleanup inherited round cancellation")
		}
		deadline, ok := call.Deadline()
		if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > 5*time.Second {
			t.Fatal("cleanup has no finite 5-second deadline")
		}
		// A hung daemon is terminated by that context; its timeout cannot replace cancellation.
		return context.DeadlineExceeded
	}
	err := (BrowserRunner{Driver: d, Image: browserImage, Exec: run}).Run(ctx, browser.RunSpec{ClaimID: "claim-1", Workload: "kodus-claim-1-workload", Service: "app", Port: 3000, Deadline: time.Minute}, nil, io.Discard)
	if !cleaned || !errors.Is(err, context.Canceled) {
		t.Fatalf("cleanup=%v err=%v", cleaned, err)
	}
}
