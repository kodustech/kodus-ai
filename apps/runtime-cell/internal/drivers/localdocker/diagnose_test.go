package localdocker

import (
	"context"
	"net"
	"os"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

type diagMock struct {
	*fakeDocker
	logs map[string][]string
}

func (m diagMock) ComposePs(context.Context, string) ([]ServiceState, error) {
	return []ServiceState{{Service: "api", State: "exited (1)"}, {Service: "db", State: "running"}}, nil
}

func (m diagMock) ComposeLogs(_ context.Context, _, service string, lines int) ([]string, error) {
	l := m.logs[service]
	if len(l) > lines {
		l = l[len(l)-lines:]
	}
	return l, nil
}

func TestDiagnoseReportsServicesLogsPortsAndDisk(t *testing.T) {
	state := t.TempDir()
	d := newDriver(t, newFake(), state)
	d.docker = diagMock{fakeDocker: newFake(), logs: map[string][]string{"api": {"boot", "Error: connect ECONNREFUSED db:5432"}, "db": {"ready"}}}
	if err := os.MkdirAll(d.cfg.MachinesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	ref, err := d.Create(context.Background(), spec(driver.RoleWorkload))
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	d.mu.Lock()
	m := d.st.Machines[ref.MachineID]
	m.Expose = []driver.ExposePort{{Service: "api", Port: 3000, Kind: "http"}, {Service: "admin", Port: 4000, Kind: "http"}}
	m.Ports = map[string]string{exposeKey("api", 3000): ln.Addr().String()}
	d.mu.Unlock()

	diag, err := d.Diagnose(context.Background(), "Claim-1", ref, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(diag.Services) != 2 || diag.Services[0].State != "exited (1)" || diag.Services[0].Log[1] != "Error: connect ECONNREFUSED db:5432" {
		t.Fatalf("services %+v", diag.Services)
	}
	if len(diag.Ports) != 2 || !diag.Ports[0].Listening || diag.Ports[1].Listening {
		t.Fatalf("ports %+v", diag.Ports)
	}
	if len(diag.Disk) != 1 || diag.Disk[0].TotalBytes <= 0 {
		t.Fatalf("disk %+v", diag.Disk)
	}
}

func TestParsePsReadsBothComposeFormats(t *testing.T) {
	lines, err := parsePs([]byte(`{"Service":"db","State":"running","Status":"Up 2 seconds"}` + "\n" + `{"Service":"api","State":"exited","Status":"Exited (1) 1 second ago"}`))
	if err != nil || len(lines) != 2 || lines[0].Service != "api" || lines[0].State != "Exited (1) 1 second ago" {
		t.Fatalf("lines %+v %v", lines, err)
	}
	arr, err := parsePs([]byte(`[{"Service":"web","State":"running"}]`))
	if err != nil || len(arr) != 1 || arr[0].State != "running" {
		t.Fatalf("array %+v %v", arr, err)
	}
}
