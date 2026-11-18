package microvm

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// keepingBackend is a backend that keeps its machines' logs.
type keepingBackend struct {
	*memBackend
	logs  []isolation.MachineLog
	asked [][2]string
}

func (k *keepingBackend) MachineLogs(org, claim string) ([]isolation.MachineLog, error) {
	k.asked = append(k.asked, [2]string{org, claim})
	return k.logs, nil
}

// A failed setup's bundle names each VM of its claim, a destroyed one too,
// in its last state, with every state's time and then its VMM's log.
func TestDiagnoseGivesEachVMsStatesAndVMMLogForTheClaim(t *testing.T) {
	at := time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)
	k := &keepingBackend{memBackend: newMemBackend(), logs: []isolation.MachineLog{{
		Name: "kodus-c-workload", Org: "org-1", Claim: "claim-1", Kept: at.Add(time.Minute), VMMLog: "Running Firecracker\nError creating the vm\n",
		Transitions: []isolation.Transition{{At: at, State: isolation.StateCreated}, {At: at.Add(time.Second), State: isolation.StateFailed, Detail: "jailer: exit status 1"}, {At: at.Add(2 * time.Second), State: isolation.StateDestroyed}},
	}}}
	d, err := New(Config{CellID: cell, Backend: k, Place: &memPlace{nets: map[string]map[string]string{}}})
	if err != nil {
		t.Fatal(err)
	}
	ref := driver.MachineRef{MachineID: "gone", Tags: map[string]string{driver.TagOrg: "org-1", driver.TagClaim: "claim-1"}}
	diag, err := d.Diagnose(context.Background(), "claim-1", ref, nil)
	if err != nil || len(diag.Services) != 1 {
		t.Fatalf("%+v %v", diag, err)
	}
	s := diag.Services[0]
	if s.Name != "vm kodus-c-workload" || s.State != isolation.StateDestroyed || len(k.asked) != 1 || k.asked[0] != [2]string{"org-1", "claim-1"} {
		t.Fatalf("%+v asked %v", s, k.asked)
	}
	want := []string{
		"2026-11-13T10:00:00Z state created",
		"2026-11-13T10:00:01Z state failed: jailer: exit status 1",
		"2026-11-13T10:00:02Z state destroyed",
		"vmm: Running Firecracker",
		"vmm: Error creating the vm",
	}
	if strings.Join(s.Log, "\n") != strings.Join(want, "\n") {
		t.Fatalf("log %q", s.Log)
	}
	if _, err := d.Diagnose(context.Background(), "claim-1", driver.MachineRef{}, nil); err == nil {
		t.Fatal("a ref with no org reads logs")
	}
	plain, _, _ := newDriver(t)
	if diag, err := plain.Diagnose(context.Background(), "claim-1", ref, nil); err != nil || len(diag.Services) != 0 {
		t.Fatalf("a backend that keeps no logs: %+v %v", diag, err)
	}
}
