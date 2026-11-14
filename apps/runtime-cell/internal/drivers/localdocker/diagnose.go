package localdocker

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// Diagnose is driver.Diagnoser: what the project's services are doing, the
// last lines each logged, whether the exposed ports answer, and the disk
// the checkouts live on. The agent redacts it before it leaves the cell.
func (d *Driver) Diagnose(ctx context.Context, _ string, ref driver.MachineRef, expose []driver.ExposePort) (driver.Diagnostics, error) {
	out := driver.Diagnostics{}
	if !isWorkload(ref) {
		return out, fmt.Errorf("localdocker: %s is not a workload", ref.MachineID)
	}
	d.mu.Lock()
	m := d.st.Machines[ref.MachineID]
	var ports map[string]string
	var published []driver.ExposePort
	if m != nil {
		ports = make(map[string]string, len(m.Ports))
		for k, v := range m.Ports {
			ports[k] = v
		}
		published = append(published, m.Expose...)
	}
	d.mu.Unlock()
	if m == nil {
		return out, fmt.Errorf("localdocker: machine %s not found", ref.MachineID)
	}
	var errs []string
	if dd, ok := d.docker.(DiagnosticDocker); ok {
		states, err := dd.ComposePs(ctx, ref.MachineID)
		if err != nil {
			errs = append(errs, "ps: "+err.Error())
		}
		for _, s := range states {
			lines, err := dd.ComposeLogs(ctx, ref.MachineID, s.Service, 500)
			if err != nil {
				lines = append(lines, "kodus: logs unavailable: "+err.Error())
			}
			out.Services = append(out.Services, driver.ServiceDiagnostics{Name: s.Service, State: s.State, Log: lines})
		}
	}
	if len(published) == 0 {
		published = expose
	}
	for _, e := range published {
		addr, ok := ports[exposeKey(e.Service, e.Port)]
		listening := false
		if ok {
			conn, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "tcp", addr)
			if err == nil {
				listening = true
				_ = conn.Close()
			}
		}
		out.Ports = append(out.Ports, driver.PortDiagnostics{Service: e.Service, Port: e.Port, Listening: listening})
	}
	if dk, ok := diskOf(d.cfg.MachinesDir); ok {
		out.Disk = append(out.Disk, dk)
	}
	if len(errs) > 0 {
		return out, fmt.Errorf("localdocker: diagnose: %s", strings.Join(errs, "; "))
	}
	return out, nil
}
