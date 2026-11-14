package dockercli

import (
	"context"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"os/exec"
	"strings"
	"testing"
)

// docker compose interpolates ${VAR} from its own environment, which was
// the whole cell's: a compose file with ${KODUS_HUB_TOKEN} got the token.
func TestCommandsDoNotSeeTheCellsEnvironment(t *testing.T) {
	if _, err := exec.LookPath("env"); err != nil {
		t.Skip("no env binary")
	}
	t.Setenv("KODUS_HUB_TOKEN", "hub-secret-value")
	t.Setenv("DOCKER_HOST", "unix:///run/docker.sock")
	out, err := CLI{Bin: "env"}.run(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "hub-secret-value") {
		t.Fatalf("docker saw the cell's secret:\n%s", out)
	}
	if !strings.Contains(string(out), "DOCKER_HOST=unix:///run/docker.sock") {
		t.Fatalf("docker lost how to reach the daemon:\n%s", out)
	}
}

func TestErrorsCarryARedactedTailOfStderr(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	_, err := ExecCommand(context.Background(), nil, "sh", "-c", "head -c 100000 /dev/zero | tr '\\0' x >&2; echo >&2; printf 'AKIA%s\\n' IOSFODNN7EXAMPLE >&2; exit 3")
	if err == nil {
		t.Fatal("no error")
	}
	if strings.Contains(err.Error(), "AKIAIOSFODNN7EXAMPLE") || len(err.Error()) > stderrTail+512 {
		e := err.Error()
		t.Fatalf("error carries %d bytes or the key: ...%s", len(e), e[max(len(e)-200, 0):])
	}
}

// ps --format joined labels with commas, so a label value
// "a,kodus.claim=victim" forged a label. inspect returns them as a map.
func TestInspectReadsLabelsAsAMap(t *testing.T) {
	run := func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		if args[0] == "inspect" {
			return []byte(`[{"Id":"c1","Name":"/kodus-claim-1-workload","Config":{"Image":"x","Labels":{"team":"a,kodus.claim=victim","kodus.claim":"claim-1"}},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":"172.30.0.5"}}}}]`), nil
		}
		return []byte("c1\n"), nil
	}
	cs, err := CLI{Run: run}.List(context.Background(), map[string]string{"kodus.cell": "cell-1"})
	if err != nil || len(cs) != 1 {
		t.Fatal(cs, err)
	}
	c := cs[0]
	if c.Labels["kodus.claim"] != "claim-1" || c.Name != "kodus-claim-1-workload" || c.IP("") != "172.30.0.5" {
		t.Fatalf("%+v", c)
	}
}

// A copy of an org's data under docker-gvisor reads it under gVisor with no
// network; the plain CopyVolume keeps Docker's default runtime.
func TestCopyVolumeInRunsTheHelperUnderTheRuntime(t *testing.T) {
	var runs [][]string
	run := func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		if args[0] == "run" {
			runs = append(runs, args)
		}
		return nil, nil
	}
	if err := (CLI{Run: run}).CopyVolumeIn(context.Background(), "runsc", "busybox:1.36", "a", "b", map[string]string{"kodus.cell": "c"}); err != nil {
		t.Fatal(err)
	}
	if err := (CLI{Run: run}).CopyVolume(context.Background(), "busybox:1.36", "a", "b", nil); err != nil {
		t.Fatal(err)
	}
	gvisor, plain := strings.Join(runs[0], " "), strings.Join(runs[1], " ")
	if !strings.Contains(gvisor, "--network none --runtime runsc ") || !strings.Contains(gvisor, "a:/from:ro") {
		t.Fatalf("copy under gVisor ran as %q", gvisor)
	}
	if strings.Contains(plain, "--runtime") {
		t.Fatalf("plain copy ran as %q", plain)
	}
}

// Nothing of an exec request reaches a shell on the cell host: the command
// is one argv element, run by sh inside the container under timeout(1).
func TestExecArgsKeepTheCommandInsideTheContainer(t *testing.T) {
	req := kodyexec.Request{Command: `echo hi; rm -rf / "$(id)"`, TimeoutMs: 1500, Limits: kodyexec.Limits{MaxProcs: 64}}
	got := ExecArgs(ExecSpec{Container: "c1", Dir: "/app", Env: []string{"CI=1"}}, req)
	want := []string{"exec", "-i=false", "-w", "/app", "-e", "CI=1", "c1", "/bin/sh", "-c", sandboxedLine, "2", "ulimit -u 64 || exit 125; " + req.Command}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv\n got %q\nwant %q", got, want)
	}
}

// A boot's phases are split where its containers started (BootTiming);
// one never started reads as zero, not as year 1.
func TestInspectReadsWhenAContainerStarted(t *testing.T) {
	out := `[{"Id":"a","Name":"/a","State":{"StartedAt":"2026-11-07T16:20:13.583502355Z"}},{"Id":"b","Name":"/b","State":{"StartedAt":"0001-01-01T00:00:00Z"}}]`
	c := CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) { return []byte(out), nil }}
	cs, err := c.Inspect(context.Background(), "a", "b")
	if err != nil {
		t.Fatal(err)
	}
	if got := cs[0].StartedAt.Format("15:04:05.000"); got != "16:20:13.583" || !cs[1].StartedAt.IsZero() {
		t.Fatalf("started %v %v", cs[0].StartedAt, cs[1].StartedAt)
	}
}

// A seed file goes to the command as its input, never as an argument (a
// file past 128 KiB is longer than one argument may be).
func TestExecInputPipesItsInputToTheContainer(t *testing.T) {
	var got []string
	var in []byte
	c := CLI{Run: func(_ context.Context, stdin []byte, _ string, args ...string) ([]byte, error) {
		got, in = args, stdin
		return nil, nil
	}}
	if _, err := c.ExecInput(context.Background(), "cdb", []byte("SELECT 1;"), "psql", "-q"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, " ") != "exec -i cdb psql -q" || string(in) != "SELECT 1;" {
		t.Fatalf("ran %q with input %q", got, in)
	}
}

// The golden data copies a database's volumes, anonymous ones included:
// inspect gives each mount, and an up may start a few services alone.
func TestInspectReadsMountsAndUpStartsOnlyTheServicesAsked(t *testing.T) {
	out := `[{"Id":"a","Name":"/a","Mounts":[{"Type":"volume","Name":"0f3a","Destination":"/var/lib/postgresql/data"},{"Type":"bind","Source":"/x","Destination":"/docker-entrypoint-initdb.d/seed.sql"}]}]`
	var calls [][]string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		calls = append(calls, args)
		return []byte(out), nil
	}}
	cs, err := c.Inspect(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	if m := cs[0].Mounts; len(m) != 2 || m[0] != (Mount{Type: "volume", Name: "0f3a", Destination: "/var/lib/postgresql/data"}) || m[1].Type != "bind" {
		t.Fatalf("mounts %+v", m)
	}
	if err := c.ComposeUp(context.Background(), ComposeProject{Name: "p", Dir: "/d", File: "/f", Services: []string{"db"}}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(calls[1], " "); !strings.HasSuffix(got, "up -d --no-build --wait --remove-orphans db") {
		t.Fatalf("up ran as %q", got)
	}
}
