//go:build dockersmoke

package dockergvisor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/reaper"
)

// The reaper against the host's Docker (no runsc needed: it never starts a
// container): a machine past its ceiling goes with its project container,
// its volume and its claim network; a live one of the same cell stays.
// Everything it makes carries a cell id of its own, removed at the end.
//
//	[DOCKER_CONFIG=~/.docker] KGR_REAP_IMAGE=postgres:16-alpine go test -tags dockersmoke -run TestSmokeReaper -v ./internal/drivers/dockergvisor/
func TestSmokeReaper(t *testing.T) {
	image := os.Getenv("KGR_REAP_IMAGE")
	if image == "" {
		t.Skip("KGR_REAP_IMAGE not set (any local image with sleep)")
	}
	cell := fmt.Sprintf("smoke-reaper-%d", os.Getpid())
	docker := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	exists := func(kind, name string) bool {
		return exec.Command("docker", kind, "inspect", name).Run() == nil
	}
	t.Cleanup(func() {
		ids, _ := exec.Command("docker", "ps", "-aq", "--filter", "label=kodus.cell="+cell).Output()
		for _, id := range strings.Fields(string(ids)) {
			_ = exec.Command("docker", "rm", "-f", id).Run()
		}
		vols, _ := exec.Command("docker", "volume", "ls", "-q", "--filter", "label=kodus.smoke="+cell).Output()
		for _, v := range strings.Fields(string(vols)) {
			_ = exec.Command("docker", "volume", "rm", "-f", v).Run()
		}
		nets, _ := exec.Command("docker", "network", "ls", "-q", "--filter", "label=kodus.cell="+cell).Output()
		for _, n := range strings.Fields(string(nets)) {
			_ = exec.Command("docker", "network", "rm", n).Run()
		}
	})
	now := time.Now().UTC()
	machine := func(claim string, hard time.Time) (string, string) {
		net, name := "kodus-"+claim, "kodus-"+claim+"-workload"
		docker("network", "create", "--internal", "--label", "kodus.cell="+cell, "--label", "kodus.claim="+claim, net)
		labels := []string{"--label", "kodus.cell=" + cell, "--label", "kodus.claim=" + claim, "--label", "kodus.hard-expires=" + hard.Format(time.RFC3339)}
		docker(append(append([]string{"run", "-d", "--name", name, "--network", net, "--label", "kodus.machine=" + name}, labels...), image, "sleep", "600")...)
		docker(append(append([]string{"run", "-d", "--name", name + "-app-1", "--network", net, "--label", "com.docker.compose.project=" + name, "--label", "com.docker.compose.service=app"}, labels...), image, "sleep", "600")...)
		docker("volume", "create", "--label", "com.docker.compose.project="+name, "--label", "kodus.smoke="+cell, name+"_pgdata")
		return name, net
	}
	pid := os.Getpid()
	gone, goneNet := machine(fmt.Sprintf("smoke%d-old", pid), now.Add(-time.Minute))
	live, liveNet := machine(fmt.Sprintf("smoke%d-live", pid), now.Add(time.Hour))

	rp, err := NewForReaper(dockercli.CLI{}, ReaperConfig{CellID: cell, WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	rep, err := (&reaper.Reaper{CellID: cell, Driver: rp}).Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Terminated) != 1 || rep.Terminated[0] != gone {
		t.Fatalf("terminated %v", rep.Terminated)
	}
	for _, c := range []string{gone, gone + "-app-1"} {
		if exists("container", c) {
			t.Fatalf("%s kept", c)
		}
	}
	if exists("volume", gone+"_pgdata") || exists("network", goneNet) {
		t.Fatal("volume or network of the expired machine kept")
	}
	if !exists("container", live) || !exists("volume", live+"_pgdata") || !exists("network", liveNet) {
		t.Fatal("the live machine was touched")
	}
}
