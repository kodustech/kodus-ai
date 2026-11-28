package dockergvisor

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// labelledContainersJSON is the holder and the project's two services as
// Docker inspects them: every compose container carries its project label.
func labelledContainersJSON(at time.Time) string {
	c := func(id, svc, ip string) string {
		return fmt.Sprintf(`{"Id":%q,"Name":"/kodus-claim-1-workload-%s-1","Config":{"Labels":{"kodus.cell":"cell-1","com.docker.compose.project":"kodus-claim-1-workload","com.docker.compose.service":%q}},"State":{"StartedAt":%q},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":%q}}}}`,
			id, svc, svc, at.Format(time.RFC3339Nano), ip)
	}
	holder := strings.TrimSuffix(strings.TrimPrefix(holderJSON, "["), "]")
	return "[" + holder + "," + c("s1", "db", "10.213.5.11") + "," + c("s2", "app", "10.213.5.10") + "]"
}

// The docker CLI spawns one claim's round trip costs the cell: each costs
// 0.15 to 0.4 s and each filtered ps scans every container on the daemon.
// Every operation on a machine checks it is this cell's in one call (it
// was three filtered ps and an inspect), and a claim network's subnet is
// read once, not at every Up (G4). Counted with the recorder, for one
// claim: create, boot, an exec, a reset, a second boot, destroy.
//
//	before: 45 spawns (Up 10, Exec 4, Reset 5, Up after reset 10, Destroy 11)
//	after:  33 spawns (Up 7, Exec 1, Reset 2, Up after reset 6, Destroy 8)
//
// A Run is two claims and up to three rounds: about 135 spawns before,
// about 90 after.
func TestOneClaimsRoundTripSpawnsFewDockerCommands(t *testing.T) {
	t0 := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFake(t0)
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`, "run": "c0ffee\n", "inspect": holderJSON, "network subnet": "10.213.5.0/24 \n", "version": "1.52\n"}}
	run := func(ctx context.Context, stdin []byte, bin string, args ...string) ([]byte, error) {
		if strings.Contains(strings.Join(args, " "), " up ") {
			r.answers["inspect"] = labelledContainersJSON(clk.Now())
		}
		return r.run(ctx, stdin, bin, args...)
	}
	d, err := New(context.Background(), dockercli.CLI{Run: run}, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), Clock: clk})
	if err != nil {
		t.Fatal(err)
	}
	counted := map[string]int{}
	mark := len(r.calls)
	phase := func(name string) {
		counted[name] = len(r.calls) - mark
		mark = len(r.calls)
	}
	ref, err := d.Create(context.Background(), spec())
	if err != nil {
		t.Fatal(err)
	}
	phase("create")
	ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
	dir := t.TempDir()
	r.answers["compose config"] = canonicalDBAndApp()
	r.answers["ps"] = "s1\ns2\n"
	if _, err := d.Up(context.Background(), driver.UpRequest{Ref: ref, Compose: []byte(dbAndApp), ProjectDir: dir}); err != nil {
		t.Fatal(err)
	}
	phase("up")
	_, _ = d.Exec(context.Background(), ref, kodyexec.Request{Command: "true", TimeoutMs: 1000})
	phase("exec")
	if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	phase("reset")
	if _, err := d.Up(context.Background(), driver.UpRequest{Ref: ref, Compose: []byte(dbAndApp), ProjectDir: dir}); err != nil {
		t.Fatal(err)
	}
	phase("up after reset")
	_ = d.Destroy(context.Background(), ref)
	phase("destroy")
	want := map[string]int{"create": 2, "up": 7, "exec": 1, "reset": 2, "up after reset": 6, "destroy": 8}
	for name, n := range want {
		if counted[name] > n {
			t.Errorf("%s spawned %d docker commands, at most %d", name, counted[name], n)
		}
	}
	if t.Failed() {
		for _, c := range r.calls {
			t.Logf("docker %s", strings.Join(c.args[:min(len(c.args), 6)], " "))
		}
	}
}
