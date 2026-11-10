package dockergvisor

import (
	"context"
	"errors"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// A setup that did not boot says why: each service's state and its last
// log lines, read from the claim's own compose project.
func TestDiagnoseReadsTheServicesAndTheirLogs(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	ref, err := d.Create(context.Background(), spec())
	if err != nil {
		t.Fatal(err)
	}
	r.answers["ps"] = "s1\n"
	r.answers["inspect"] = `[{"Id":"s1","Name":"/` + ref.MachineID + `-app-1","Config":{"Labels":{"kodus.cell":"cell-1"}}}]`
	r.answers["compose ps"] = `{"Service":"app","State":"exited","Status":"Exited (1) 2 seconds ago"}` + "\n" + `{"Service":"db","State":"running","Status":"Up 5 seconds (healthy)"}`
	r.answers["compose logs"] = "> sample-app@1.0.0 start\nError: Missing required environment variable: SESSION_SECRET\n"
	diag, err := d.Diagnose(context.Background(), "claim-1", ref, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(diag.Services) != 2 || diag.Services[0].Name != "app" || diag.Services[0].State != "Exited (1) 2 seconds ago" {
		t.Fatalf("services %+v", diag.Services)
	}
	if l := diag.Services[0].Log; len(l) != 2 || l[1] != "Error: Missing required environment variable: SESSION_SECRET" {
		t.Fatalf("log %q", l)
	}
	if f := r.find("compose", "-p", ref.MachineID, "logs"); f == nil {
		t.Fatalf("logs not read from the claim's project: %v", r.calls)
	}
}

// Another cell's machine, or one that is not the workload, is never read.
func TestDiagnoseOnlyReadsThisCellsWorkload(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	ref, _ := d.Create(context.Background(), spec())
	r.answers["ps"] = "s1\n"
	r.answers["inspect"] = `[{"Id":"s1","Name":"/` + ref.MachineID + `-app-1","Config":{"Labels":{"kodus.cell":"cell-2"}}}]`
	if _, err := d.Diagnose(context.Background(), "claim-1", ref, nil); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("err %v", err)
	}
	obs := ref
	obs.Tags = map[string]string{driver.TagRole: string(driver.RoleObserver)}
	if _, err := d.Diagnose(context.Background(), "claim-1", obs, nil); err == nil {
		t.Fatal("an observer machine was diagnosed")
	}
}
