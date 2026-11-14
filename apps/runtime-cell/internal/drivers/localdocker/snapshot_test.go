package localdocker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// snapFake is the fake Docker that can also copy volumes.
type snapFake struct {
	*fakeDocker
	failCopy map[string]bool // "from>to"
	volumes  []dockercli.Volume
	log      *bytes.Buffer
}

func (s *snapFake) ComposeStopServices(_ context.Context, project string, services ...string) error {
	s.calls = append(s.calls, strings.TrimSpace("stop "+project+" "+strings.Join(services, " ")))
	return nil
}

func (s *snapFake) CopyVolume(_ context.Context, from, to string, labels map[string]string) error {
	s.calls = append(s.calls, fmt.Sprintf("copy %s>%s", from, to))
	if s.failCopy[from+">"+to] {
		return errors.New("disk full")
	}
	if labels != nil {
		s.volumes = append(s.volumes, dockercli.Volume{Name: to, Labels: labels})
	}
	return nil
}

func (s *snapFake) Volumes(_ context.Context, labels map[string]string) ([]dockercli.Volume, error) {
	var out []dockercli.Volume
	for _, v := range s.volumes {
		ok := true
		for k, want := range labels {
			if got, has := v.Labels[k]; !has || (want != "" && got != want) {
				ok = false
			}
		}
		if ok {
			out = append(out, v)
		}
	}
	return out, nil
}

func (s *snapFake) VolumeRemove(_ context.Context, names ...string) error {
	if len(names) > 0 {
		s.calls = append(s.calls, "rmvol "+strings.Join(names, " "))
	}
	return nil
}

const snapshotCompose = `services:
  api: { image: api, volumes: ["./src:/src", "streams:/streams"] }
  db: { image: postgres:16, volumes: ["pgdata:/var/lib/postgresql/data"] }
  web: { image: web, profiles: [off], volumes: ["cache:/cache"] }
  queue: { image: rabbit }
volumes: { pgdata: {}, streams: {}, cache: {} }
`

func snapshotRig(t *testing.T, reset string) (*Driver, *snapFake, driver.MachineRef, string) {
	t.Helper()
	m := &snapFake{fakeDocker: newFake(), failCopy: map[string]bool{}, log: &bytes.Buffer{}}
	cfg := config(t, t.TempDir())
	cfg.Log = slog.New(slog.NewTextHandler(m.log, nil))
	d, err := New(context.Background(), m, cfg)
	if err != nil {
		t.Fatal(err)
	}
	d.getStatus = func(context.Context, string) (int, error) { return 200, nil }
	work, _ := d.Create(context.Background(), spec(driver.RoleWorkload))
	dir := writeRepo(t, map[string]string{"compose.yaml": snapshotCompose})
	_ = os.MkdirAll(filepath.Join(dir, ".kodus"), 0o700)
	_ = os.WriteFile(filepath.Join(dir, recipe.Path), []byte("version: 1\ndata: { migrate: ./migrate, reset: "+reset+" }\n"), 0o600)
	return d, m, work, dir
}

func callsFrom(m *snapFake, from int) string { return strings.Join(m.calls[from:], "\n") }

// The first ready boot is copied once: the services that mount named
// volumes are stopped (not the one behind a profile, not the one without
// volumes), each volume is copied, the project comes up again.
func TestSnapshotIsTakenOnceAfterTheFirstReadyBoot(t *testing.T) {
	ctx := context.Background()
	d, m, work, dir := snapshotRig(t, "snapshot")
	if err := d.Boot(ctx, work, dir); err != nil {
		t.Fatal(err)
	}
	p := work.MachineID
	want := []string{
		"sh ./migrate",
		"stop " + p + " api db",
		"copy " + p + "_pgdata>" + p + "_pgdata-kodus-snapshot",
		"copy " + p + "_streams>" + p + "_streams-kodus-snapshot",
		"up " + p,
	}
	got := m.joined()
	at := strings.Index(got, want[0])
	if at < 0 || !strings.HasPrefix(got[at:], strings.Join(want, "\n")) {
		t.Fatalf("calls:\n%s", got)
	}
	if strings.Contains(got, p+"_cache") {
		t.Fatal("copied the volume of a service that does not start")
	}
	if r, _ := d.LastBoot(work.Tags[driver.TagClaim]); r.Kind != bootKindBoot || !strings.Contains(m.log.String(), "phase=snapshot") || !strings.Contains(m.log.String(), "snapshotMs=") {
		t.Fatalf("report %+v, log:\n%s", r, m.log)
	}
	for _, v := range m.volumes {
		if v.Labels[labelMachine] != p || v.Labels["kodus.cell"] != "cell-1" || v.Labels[labelSnapshotOf] == "" {
			t.Fatalf("snapshot volume labels %v", v.Labels)
		}
	}
	// A reset does not take another one.
	n := len(m.calls)
	if err := d.Reset(ctx, work, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(callsFrom(m, n), ">"+p+"_pgdata-kodus-snapshot") {
		t.Fatalf("snapshot taken again:\n%s", callsFrom(m, n))
	}
}

// A snapshot reset stops everything, copies every volume back, then comes
// up with no build, down, migrate or seed, then the health check.
func TestSnapshotResetRestoresInOrder(t *testing.T) {
	ctx := context.Background()
	d, m, work, dir := snapshotRig(t, "snapshot")
	if err := d.Boot(ctx, work, dir); err != nil {
		t.Fatal(err)
	}
	p := work.MachineID
	n := len(m.calls)
	if err := d.Reset(ctx, work, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	got := callsFrom(m, n)
	want := strings.Join([]string{
		"stop " + p,
		"copy " + p + "_pgdata-kodus-snapshot>" + p + "_pgdata",
		"copy " + p + "_streams-kodus-snapshot>" + p + "_streams",
		"up " + p,
	}, "\n")
	if !strings.HasPrefix(got, want) {
		t.Fatalf("restore calls:\n%s\nwant prefix:\n%s", got, want)
	}
	for _, never := range []string{"down ", "build ", "sh ./migrate"} {
		if strings.Contains(got, never) {
			t.Fatalf("a snapshot reset ran %q:\n%s", never, got)
		}
	}
	if r, _ := d.LastBoot(work.Tags[driver.TagClaim]); r.Kind != bootKindReset || r.DownMs != 0 || !strings.Contains(m.log.String(), "phase=restore") {
		t.Fatalf("report %+v, log:\n%s", r, m.log)
	}
}

// A restore that fails recreates (down -v, up, migrate) and takes a new
// snapshot from that boot: the Run never stays stuck on a broken copy.
func TestSnapshotRestoreFailureFallsBackToRecreate(t *testing.T) {
	ctx := context.Background()
	d, m, work, dir := snapshotRig(t, "snapshot")
	if err := d.Boot(ctx, work, dir); err != nil {
		t.Fatal(err)
	}
	p := work.MachineID
	m.failCopy[p+"_pgdata-kodus-snapshot>"+p+"_pgdata"] = true
	n := len(m.calls)
	if err := d.Reset(ctx, work, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatalf("fallback failed: %v", err)
	}
	got := callsFrom(m, n)
	for _, want := range []string{"down " + p + " v=true", "sh ./migrate", "copy " + p + "_pgdata>" + p + "_pgdata-kodus-snapshot"} {
		if !strings.Contains(got, want) {
			t.Fatalf("no %q in fallback:\n%s", want, got)
		}
	}
	if !strings.Contains(m.log.String(), "localdocker.reset.snapshot_fallback") || !strings.Contains(m.log.String(), "disk full") {
		t.Fatalf("fallback not logged with its reason:\n%s", m.log)
	}
}

// A snapshot that cannot be taken leaves the boot ready (the project is up
// again) and the next reset recreates.
func TestSnapshotTakeFailureKeepsTheBootAndRecreatesLater(t *testing.T) {
	ctx := context.Background()
	d, m, work, dir := snapshotRig(t, "snapshot")
	p := work.MachineID
	m.failCopy[p+"_pgdata>"+p+"_pgdata-kodus-snapshot"] = true
	if err := d.Boot(ctx, work, dir); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(m.joined(), "stop "+p+" api db\ncopy "+p+"_pgdata>"+p+"_pgdata-kodus-snapshot\nup "+p) {
		t.Fatalf("project not brought up again after the failed copy:\n%s", m.joined())
	}
	if d.hasSnapshot(p) {
		t.Fatal("a failed snapshot is recorded")
	}
	delete(m.failCopy, p+"_pgdata>"+p+"_pgdata-kodus-snapshot")
	n := len(m.calls)
	if err := d.Reset(ctx, work, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	if got := callsFrom(m, n); !strings.Contains(got, "down "+p+" v=true") || !d.hasSnapshot(p) {
		t.Fatalf("no recreate, or no new snapshot after it:\n%s", got)
	}
}

func TestDestroyRemovesTheSnapshots(t *testing.T) {
	ctx := context.Background()
	d, m, work, dir := snapshotRig(t, "snapshot")
	if err := d.Boot(ctx, work, dir); err != nil {
		t.Fatal(err)
	}
	p := work.MachineID
	if err := d.Destroy(ctx, work); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(m.joined(), "rmvol "+p+"_pgdata-kodus-snapshot "+p+"_streams-kodus-snapshot") {
		t.Fatalf("snapshots not removed:\n%s", m.joined())
	}
}

// recreate (the default) never stops, copies or snapshots.
func TestRecreateTakesNoSnapshot(t *testing.T) {
	ctx := context.Background()
	d, m, work, dir := snapshotRig(t, "recreate")
	if err := d.Boot(ctx, work, dir); err != nil {
		t.Fatal(err)
	}
	if err := d.Reset(ctx, work, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(m.joined(), "copy ") || strings.Contains(m.joined(), "stop ") {
		t.Fatalf("calls:\n%s", m.joined())
	}
}
