package integration

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

const (
	fakeAWS = "AKIAIOSFODNN7EXAMPLE"
	fakeJWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
)

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func execOn(t *testing.T, ctx context.Context, w *world, claim, command string) *protocol.StepResultBody {
	t.Helper()
	step := hubclient.NewID()
	if err := w.hub.Send(ctx, "cell-1", claim, &protocol.ExecBody{StepID: step, Command: command, TimeoutMs: 5000}); err != nil {
		t.Fatalf("exec: %v", err)
	}
	ev, err := w.hub.WaitFor(ctx, stepResult(step))
	if err != nil {
		t.Fatal(err)
	}
	return ev.Body.(*protocol.StepResultBody)
}

func nackCode(err error) string {
	var n *hubclient.NackError
	if errors.As(err, &n) {
		return n.Code
	}
	return ""
}

// S-51: a command prints the download token in plain, base64 and percent;
// the app log carries an AWS key and a JWT the cell never knew. None of
// them reaches step.result, and the count is recorded on it.
func TestS51RedactionBeforeTheResultLeavesTheCell(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	token := "ghs_dl+Tok/en=42Zq7"
	w.acquire(t, ctx, "claim-s51", "org-a", func(b *protocol.ClaimAcquireBody) { b.RepoToken = token })

	lines := []string{
		"plain " + token,
		"base64 " + base64.StdEncoding.EncodeToString([]byte(token)),
		"basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token)),
		"percent " + redact.EncodeURIComponent(token),
		"app: AWS_ACCESS_KEY_ID=" + fakeAWS,
		"app: issued session " + fakeJWT,
	}
	quoted := make([]string, len(lines))
	for i, l := range lines {
		quoted[i] = shellQuote(l)
	}
	res := execOn(t, ctx, w, "claim-s51", "printf '%s\\n' "+strings.Join(quoted, " "))
	frame, _ := json.Marshal(res)
	for _, leaked := range []string{token, base64.StdEncoding.EncodeToString([]byte(token)), redact.EncodeURIComponent(token), fakeAWS, fakeJWT} {
		if strings.Contains(string(frame), leaked) {
			t.Errorf("step.result carries %q:\n%s", leaked, frame)
		}
	}
	for _, m := range []string{"[redacted:download-token]", "[redacted:aws-access-token]", "[redacted:jwt]"} {
		if !strings.Contains(res.Exec.Stdout, m) {
			t.Errorf("no %s in %q", m, res.Exec.Stdout)
		}
	}
	if res.Redactions == nil || *res.Redactions < 6 {
		t.Fatalf("redactions %v in %q", res.Redactions, res.Exec.Stdout)
	}
	// Ordinary output passes untouched and the count says so.
	clean := execOn(t, ctx, w, "claim-s51", "echo GET /users 200")
	if clean.Exec.Stdout != "GET /users 200\n" || clean.Redactions == nil || *clean.Redactions != 0 {
		t.Fatalf("clean output %q %v", clean.Exec.Stdout, clean.Redactions)
	}
}

// S-52: a PR claim never bakes, never feeds the pool, and its machine is
// destroyed on release; what the PR wrote is gone for the next claim.
func TestS52PRNeverPoisonsImageOrPool(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	w.acquire(t, ctx, "claim-pr", "org-a", func(b *protocol.ClaimAcquireBody) { b.Side = protocol.SidePr })
	var prMachine driver.MachineRef
	for _, m := range w.drv.Machines() {
		if m.Spec.Role == driver.RoleWorkload {
			prMachine = m.Ref
		}
	}
	// The PR writes into the dependency cache and ends normally.
	if r := execOn(t, ctx, w, "claim-pr", "mkdir -p .cache/npm && echo poisoned > .cache/npm/left-pad.js"); r.Exec == nil || r.Exec.ExitCode != 0 {
		t.Fatalf("write cache: %+v", r)
	}

	bake := &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", RecipeSha: "r1", Sha: sha}
	if err := w.hub.Send(ctx, "cell-1", "claim-pr", bake); nackCode(err) != "pr_claim" {
		t.Fatalf("image.bake on a PR claim: %v", err)
	}
	if err := w.hub.Send(ctx, "cell-1", "claim-pr", &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: "img-1", Size: 2}); nackCode(err) != "pr_claim" {
		t.Fatalf("pool.target on a PR claim: %v", err)
	}
	if bakes := w.drv.BakesSnapshot(); len(bakes) != 0 {
		t.Fatalf("baked %+v", bakes)
	}

	if err := w.hub.Send(ctx, "cell-1", "claim-pr", &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(w.drv.Machines()) != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	destroyed := false
	for _, id := range w.drv.DestroyedIDs() {
		destroyed = destroyed || id == prMachine.MachineID
	}
	if !destroyed || len(w.drv.Machines()) != 0 {
		t.Fatalf("PR machine %s not destroyed: %v", prMachine.MachineID, w.drv.DestroyedIDs())
	}

	// The next claim gets a new machine from the image, without the file.
	w.acquire(t, ctx, "claim-next", "org-a")
	for _, m := range w.drv.Machines() {
		if m.Spec.Role != driver.RoleWorkload {
			continue
		}
		if m.Ref.MachineID == prMachine.MachineID || m.Ref.ImageID != "img-1" {
			t.Fatalf("next claim got %+v", m.Ref)
		}
		if _, err := os.Stat(filepath.Join(w.machines, m.Ref.MachineID, "workspace", ".cache", "npm", "left-pad.js")); !os.IsNotExist(err) {
			t.Fatalf("the PR's cache file reached the next claim: %v", err)
		}
	}

	// A bake with no claim (the setup path, commit checked upstream) runs
	// on a clean machine; pool.target takes only what this cell baked.
	if err := w.hub.Send(ctx, "cell-1", "", bake); err != nil {
		t.Fatalf("image.bake: %v", err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for len(w.drv.BakesSnapshot()) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if bakes := w.drv.BakesSnapshot(); len(bakes) != 1 || bakes[0].SHA != sha || bakes[0].KMSKeyRef != "kms-org-a" {
		t.Fatalf("bakes %+v", bakes)
	}
	if err := w.hub.Send(ctx, "cell-1", "", &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: "img-from-a-pr", Size: 2}); nackCode(err) != "image_not_baked" {
		t.Fatalf("pool.target of an unknown image: %v", err)
	}
}

// §11 runbook: a failed setup sends a redacted failure bundle; with the
// diagnostic hold the machines stay, exec works and verdict probes do not.
func TestSetupFailureBundleAndDiagnosticHold(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	token := "ghs_setupTokenAbcdef0123"
	logs := make([]string, 0, 600)
	for i := 0; i < 598; i++ {
		logs = append(logs, "api | booting step")
	}
	logs = append(logs, "api | using token "+token, "api | AWS_ACCESS_KEY_ID="+fakeAWS+" rejected: ECONNREFUSED db:5432")
	w.drv.Diagnostics = &driver.Diagnostics{
		Services: []driver.ServiceDiagnostics{{Name: "api", State: "exited (1)", Log: logs}, {Name: "db", State: "running", Log: []string{"db | ready"}}},
		Ports:    []driver.PortDiagnostics{{Service: "api", Port: w.appPort, Listening: false}},
		Disk:     []driver.DiskDiagnostics{{Path: "/", TotalBytes: 60 << 30, FreeBytes: 1 << 20}},
	}
	setup := func(claim string, hold bool) *protocol.ClaimFailedBody {
		t.Helper()
		body := w.acquireBody("org-a")
		body.Consumer, body.RepoToken = protocol.ConsumerSetup, token
		body.Sha = strings.Repeat("f", 40) // no tarball for this commit: the fetch fails after the machines exist
		body.HardExpiresAt = time.Now().Add(40 * time.Minute).UTC().Format(time.RFC3339)
		body.DiagnosticHold = &hold
		if err := w.hub.Send(ctx, "cell-1", claim, body); err != nil {
			t.Fatal(err)
		}
		ev, err := w.hub.WaitSettled(ctx, claim)
		if err != nil {
			t.Fatal(err)
		}
		f, ok := ev.Body.(*protocol.ClaimFailedBody)
		if !ok {
			t.Fatalf("setup did not fail: %T", ev.Body)
		}
		return f
	}

	f := setup("claim-setup-held", true)
	if f.Signature != "repo_fetch" || f.Held == nil || !*f.Held || f.Bundle == nil {
		t.Fatalf("claim.failed %+v", f)
	}
	b := f.Bundle
	frame, _ := json.Marshal(b)
	if strings.Contains(string(frame), token) || strings.Contains(string(frame), fakeAWS) || b.Redactions < 2 {
		t.Fatalf("bundle not redacted (%d): %s", b.Redactions, frame)
	}
	if len(b.Services) != 2 || len(b.Services[0].LogTail) != 500 || !b.Truncated || b.Services[0].State != "exited (1)" ||
		len(b.Ports) != 1 || b.Ports[0].Listening || len(b.Disk) != 1 || b.Disk[0].FreeBytes != 1<<20 ||
		len(b.DeniedEgress) != 1 || b.DeniedEgress[0].Host != "registry.npmjs.org" {
		t.Fatalf("bundle %+v", b)
	}
	if last := b.Services[0].LogTail[499]; !strings.Contains(last, "[redacted:aws-access-token]") {
		t.Fatalf("last line %q", last)
	}
	// Held: the machines are alive, exec reaches them, verdict probes do not.
	if n := len(w.drv.Machines()); n != 2 {
		t.Fatalf("held claim has %d machines", n)
	}
	if err := w.hub.Send(ctx, "cell-1", "claim-setup-held", probeRun(hubclient.NewID(), w.appPort, "/users")); nackCode(err) != "diagnostic_hold" {
		t.Fatalf("probe.run on a held claim: %v", err)
	}
	if r := execOn(t, ctx, w, "claim-setup-held", "echo investigating"); r.Exec == nil || r.Exec.Stdout != "investigating\n" {
		t.Fatalf("exec on a held claim: %+v", r)
	}
	if err := w.hub.Send(ctx, "cell-1", "claim-setup-held", &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(w.drv.Machines()) != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := len(w.drv.Machines()); n != 0 {
		t.Fatalf("release left %d machines", n)
	}

	// Without the hold, the bundle still comes and nothing is kept.
	f = setup("claim-setup-plain", false)
	if f.Held != nil || f.Bundle == nil {
		t.Fatalf("claim.failed %+v", f)
	}
	if n := len(w.drv.Machines()); n != 0 {
		t.Fatalf("failed setup without hold kept %d machines", n)
	}

	// A PR claim never asks for a hold.
	pr := w.acquireBody("org-a")
	pr.Side, pr.Consumer = protocol.SidePr, protocol.ConsumerSetup
	pr.HardExpiresAt = time.Now().Add(40 * time.Minute).UTC().Format(time.RFC3339)
	yes := true
	pr.DiagnosticHold = &yes
	if err := w.hub.Send(ctx, "cell-1", "claim-pr-hold", pr); nackCode(err) != "diagnostic_hold_refused" {
		t.Fatalf("hold on a PR claim: %v", err)
	}
}
