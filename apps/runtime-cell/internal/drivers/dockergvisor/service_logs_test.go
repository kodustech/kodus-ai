package dockergvisor

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// A probe round's service logs: each service's lines in the window, timed
// by the daemon, oldest first, read from the claim's own project with
// --timestamps --since --until.
func TestServiceLogsReadsTheWindowWithTimestamps(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	ref, err := d.Create(context.Background(), spec())
	if err != nil {
		t.Fatal(err)
	}
	r.answers["ps"] = "s1\n"
	r.answers["inspect"] = `[{"Id":"s1","Name":"/` + ref.MachineID + `-app-1","Config":{"Labels":{"kodus.cell":"cell-1"}}}]`
	r.answers["compose ps"] = `{"Service":"app","State":"running","Status":"Up"}`
	r.answers["compose logs"] = "2026-11-06T12:00:00.010000000Z POST /orders 500\n2026-11-06T12:00:00.005000000Z TypeError: cart.items\n    at handler (cart.js:3)\n"
	t0 := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	got, err := d.ServiceLogs(context.Background(), "claim-1", ref, t0, t0.Add(time.Second), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].Text != "TypeError: cart.items" || got[0].Service != "app" || !got[0].At.Equal(t0.Add(5*time.Millisecond)) {
		t.Fatalf("%+v", got)
	}
	// A continuation line takes its line's time.
	if got[1].Text != "    at handler (cart.js:3)" || !got[1].At.Equal(got[0].At) {
		t.Fatalf("%+v", got[1])
	}
	call := r.find("compose", "-p", ref.MachineID, "logs")
	if call == nil {
		t.Fatalf("logs not read from the claim's project: %v", r.calls)
	}
	joined := strings.Join(call, " ")
	for _, want := range []string{"--timestamps", "--since 2026-11-06T12:00:00Z", "--until 2026-11-06T12:00:01Z", "--tail 100"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("%q lacks %q", joined, want)
		}
	}
}

// Another cell's machine, or one that is not the workload, is never read.
func TestServiceLogsOnlyReadsThisCellsWorkload(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	ref, _ := d.Create(context.Background(), spec())
	r.answers["ps"] = "s1\n"
	r.answers["inspect"] = `[{"Id":"s1","Name":"/` + ref.MachineID + `-app-1","Config":{"Labels":{"kodus.cell":"cell-2"}}}]`
	now := time.Now()
	if _, err := d.ServiceLogs(context.Background(), "claim-1", ref, now, now, 10); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("err %v", err)
	}
	obs := ref
	obs.Tags = map[string]string{driver.TagRole: string(driver.RoleObserver)}
	if _, err := d.ServiceLogs(context.Background(), "claim-1", obs, now, now, 10); err == nil {
		t.Fatal("an observer machine's logs were read")
	}
}
