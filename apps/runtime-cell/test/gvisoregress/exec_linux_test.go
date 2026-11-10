//go:build linux

package gvisoregress

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// The app service has a working directory; the recipe names it public.
const execProject = `services:
  app:
    image: alpine:3.20
    working_dir: /srv
    command: ["sleep", "300"]
  db:
    image: alpine:3.20
    command: ["sleep", "300"]
`

// An exec step runs inside the public service's container, under runsc, in
// its working directory, and its deadline holds inside the sandbox: the
// command is gone at the timeout, not only the docker client.
func TestExecRunsInThePublicServiceUnderGVisorAndStopsAtItsDeadline(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "cell"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{CellID: "cell-e2e", HolderImage: "alpine:3.20", WorkDir: filepath.Join(dir, "cell")})
	if err != nil {
		t.Fatal(err)
	}
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-e2e", OrgID: "org-e2e", ClaimID: "claim-exec"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.ReleaseClaim(context.Background(), n) })
	spec := drivertest.BaseSpec("cell-e2e", "claim-exec", n)
	spec.OrgID, spec.ExpiresAt, spec.HardExpiresAt = "org-e2e", time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
	ref, err := d.Create(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Destroy(context.Background(), ref) })
	project := filepath.Join(dir, "checkout")
	if err := os.MkdirAll(filepath.Dir(filepath.Join(project, recipe.Path)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, recipe.Path), []byte("version: 1\nservices:\n  compose:\n    files: [docker-compose.yml]\n    public: app\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Up(ctx, ref, []byte(execProject), project); err != nil {
		t.Fatalf("up: %v", err)
	}

	res, err := d.Exec(ctx, ref, kodyexec.Request{Command: `echo "$GREETING from $(pwd) on $(uname -r)"`, Env: []string{"GREETING=hi"}, TimeoutMs: 20_000})
	if err != nil {
		t.Fatal(err)
	}
	// gVisor's kernel says so in its release; the host's does not.
	if res.ExitCode != 0 || !strings.Contains(res.Stdout, "hi from /srv on ") || !strings.Contains(res.Stdout, "gvisor") {
		t.Fatalf("exec did not run in the app's gVisor sandbox: %+v", res)
	}
	if res, _ := d.Exec(ctx, ref, kodyexec.Request{Command: "exit 3", TimeoutMs: 10_000}); res.ExitCode != 3 {
		t.Fatalf("exit code: %+v", res)
	}

	start := time.Now()
	res, err = d.Exec(ctx, ref, kodyexec.Request{Command: "sleep 47", TimeoutMs: 2_000})
	if err != nil {
		t.Fatal(err)
	}
	if !res.TimedOut || res.ExitCode != kodyexec.TimeoutExitCode || time.Since(start) > 10*time.Second {
		t.Fatalf("a command past its deadline: %+v after %s", res, time.Since(start))
	}
	top, _ := exec.Command("docker", "top", ref.MachineID+"-app-1").CombinedOutput()
	if strings.Contains(string(top), "sleep 47") {
		t.Fatalf("the command outlived its deadline in the sandbox:\n%s", top)
	}
}
