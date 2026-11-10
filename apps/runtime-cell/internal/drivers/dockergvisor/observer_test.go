package dockergvisor

import (
	"context"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
)

const observerJSON = `[{"Id":"c0ffee","Name":"/kodus-claim-1-observer","Config":{"Image":"o","Labels":{"kodus.cell":"cell-1"}},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":"172.30.0.6"},"kodus-observers-cell-1":{"IPAddress":"172.31.0.2"}}}}]`

func TestTheObserverMachineServesProbesUnderGVisor(t *testing.T) {
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`, "run": "c0ffee\n", "create": "c0ffee\n", "inspect": observerJSON, "network subnet": "10.213.5.0/24 \n"}}
	tls := t.TempDir()
	d, err := New(context.Background(), dockercli.CLI{Run: r.run}, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc",
		ObserverImage: "kodus/observer@sha256:def", ObserverTLSDir: tls, WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	s := spec()
	s.Role = driver.RoleObserver
	ref, err := d.Create(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	// The claim network has no address on the host: the cell dials the
	// observer on the cell's observer network, which keeps observers apart.
	if ref.PrivateAddress != "172.31.0.2" {
		t.Fatalf("the cell would dial %s, not the observer network address", ref.PrivateAddress)
	}
	nc := strings.Join(r.find("network", "create"), " ")
	for _, want := range []string{"--internal", "com.docker.network.bridge.enable_icc=false", "kodus.cell=cell-1", "kodus-observers-cell-1"} {
		if !strings.Contains(nc, want) || strings.Contains(nc, "inhibit_ipv4") {
			t.Fatalf("observer network lacks %q (or has no host address): %s", want, nc)
		}
	}
	// gVisor takes no network after start: created, both networks, then started.
	var order []string
	for _, c := range r.calls {
		if w := c.args[0]; w == "create" || w == "start" || (w == "network" && c.args[1] == "connect") || w == "run" {
			order = append(order, strings.Join(c.args[:min(len(c.args), 4)], " "))
		}
	}
	if want := []string{"create --name kodus-claim-1-observer --runtime", "network connect kodus-observers-cell-1 c0ffee", "start c0ffee"}; strings.Join(order, "|") != strings.Join(want, "|") {
		t.Fatalf("observer lifecycle %q, want %q", order, want)
	}
	run := strings.Join(r.find("create"), " ")
	for _, want := range []string{"--runtime runsc", "--network kodus-claim-1", "--cap-drop ALL", "--read-only",
		"-v " + tls + ":/etc/kodus/observer:ro", "kodus/observer@sha256:def /observer -listen :7443 -cell-id cell-1 -cert /etc/kodus/observer/cert.pem"} {
		if !strings.Contains(run, want) {
			t.Fatalf("observer run lacks %q: %s", want, run)
		}
	}
	if strings.Contains(run, "sleep infinity") {
		t.Fatalf("the observer is a bare holder: %s", run)
	}

	// The workload stays a holder: the observer image is for observers only.
	r.calls = nil
	r.answers["inspect"] = holderJSON
	w := spec()
	w.ClaimID, w.ClaimGroupID = "claim-2", "kodus-claim-2"
	if _, err := d.Create(context.Background(), w); err != nil {
		t.Fatal(err)
	}
	if run := strings.Join(r.find("run"), " "); !strings.Contains(run, "kodus/holder@sha256:abc sleep infinity") || strings.Contains(run, "/etc/kodus/observer") {
		t.Fatalf("workload run: %s", run)
	}
	if r.has("kodus-observers-") {
		t.Fatal("a workload joined the observer network")
	}
}

func TestAnObserverImageNeedsItsCertificates(t *testing.T) {
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`}}
	if _, err := New(context.Background(), dockercli.CLI{Run: r.run}, Config{CellID: "cell-1", HolderImage: "h", ObserverImage: "o"}); err == nil {
		t.Fatal("an observer without TLS was accepted")
	}
}

func TestTargetsPointAtEachServiceNotTheHolder(t *testing.T) {
	d, _, err := newDriver(t, `{"runsc":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Targets("kodus-claim-1-workload", []observer.Target{{Service: "app", Port: 3000}}); err == nil {
		t.Fatal("targets of a project that is not up")
	}
	d.machineLocked("kodus-claim-1-workload").services = map[string]string{"app": "10.213.5.10", "db": "10.213.5.11"}
	got, err := d.Targets("kodus-claim-1-workload", []observer.Target{{Service: "app", Port: 3000, Kind: "http", Address: "172.30.0.5:3000"}})
	if err != nil || len(got) != 1 || got[0].Address != "10.213.5.10:3000" || got[0].Kind != "http" {
		t.Fatalf("targets %+v, %v", got, err)
	}
	if _, err := d.Targets("kodus-claim-1-workload", []observer.Target{{Service: "worker", Port: 9000}}); err == nil {
		t.Fatal("a service the project does not run got an address")
	}
	if err := d.Destroy(context.Background(), driver.MachineRef{MachineID: "kodus-claim-1-workload"}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Targets("kodus-claim-1-workload", []observer.Target{{Service: "app", Port: 3000}}); err == nil {
		t.Fatal("a destroyed machine kept its addresses")
	}
}
