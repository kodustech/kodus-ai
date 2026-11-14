package agent

import (
	"context"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// Bundle limits: the frame is at most 1 MiB; logs get half of it.
const (
	bundleLines    = 500
	bundleServices = 32
	bundlePorts    = 64
	bundleDisks    = 8
	bundleDenied   = 100
	bundleLogBytes = 512 << 10
	bundleTimeout  = time.Minute
)

// bootOutputService names the bundle entry with the boot's own output.
const bootOutputService = "boot output"

// collectBundle is the failure bundle of a setup claim: service states,
// the last 500 log lines per service, ports, disk and denied egress,
// redacted with the claim's redactor before it is attached (S-51). cause is
// what failed the claim: when it carries the boot's output (a build's log,
// compose's own messages), its last lines go in as a "boot output" entry,
// since the cause is there and the services may not exist yet.
func (a *Agent) collectBundle(ctx context.Context, c *claims.Claim, cause error) *protocol.ClaimFailedBodyBundle {
	w := newBundleWriter(c.Redactor(), a.clock.Now())
	if d := a.cfg.Diagnoser; d != nil {
		expose := make([]driver.ExposePort, 0, len(c.Acquire.Expose))
		for _, e := range c.Acquire.Expose {
			expose = append(expose, driver.ExposePort{Service: e.Service, Port: int(e.Port), Kind: string(e.Kind)})
		}
		dctx, cancel := context.WithTimeout(ctx, bundleTimeout)
		diag, err := d.Diagnose(dctx, c.ID, c.Machines().Workload, expose)
		cancel()
		if err != nil {
			c.Log.Warn("bundle.diagnose", "err", err)
		}
		w.services(diag.Services)
		w.ports(diag.Ports)
		w.disk(diag.Disk)
	}
	w.bootOutput(cause)
	if src := a.cfg.DeniedEgress; src != nil {
		w.deniedEgress(src.Denied(c.ID))
	}
	trimLogs(w.b, bundleLogBytes)
	return w.b
}

// bundleWriter fills a failure bundle from what the cell read: every text
// redacted with the claim's redactor and cut to the bundle's bounds, every
// list cut to its count. Whatever was cut marks the bundle truncated.
type bundleWriter struct {
	b *protocol.ClaimFailedBodyBundle
	r *redact.Redactor
}

func newBundleWriter(r *redact.Redactor, now time.Time) *bundleWriter {
	if r == nil {
		r = redact.New()
	}
	return &bundleWriter{r: r, b: &protocol.ClaimFailedBodyBundle{
		Services:     []protocol.ClaimFailedBodyBundleServicesItem{},
		Ports:        []protocol.ClaimFailedBodyBundlePortsItem{},
		Disk:         []protocol.ClaimFailedBodyBundleDiskItem{},
		DeniedEgress: []protocol.ClaimFailedBodyBundleDeniedEgressItem{},
		CollectedAt:  protocol.FormatTime(now),
	}}
}

func (w *bundleWriter) red(s string, max int) string {
	out, n := w.r.String(s)
	w.b.Redactions += int64(n)
	out, cut := redact.Clip(out, max)
	if cut {
		w.b.Truncated = true
	}
	return out
}

// services adds each service's state and the tail of its log.
func (w *bundleWriter) services(services []driver.ServiceDiagnostics) {
	for i, s := range services {
		if i == bundleServices {
			w.b.Truncated = true
			break
		}
		lines := s.Log
		if len(lines) > bundleLines {
			lines, w.b.Truncated = lines[len(lines)-bundleLines:], true
		}
		item := protocol.ClaimFailedBodyBundleServicesItem{Name: w.red(s.Name, 128), State: w.red(s.State, 128), LogTail: make([]string, 0, len(lines))}
		if item.Name == "" {
			item.Name = "unknown"
		}
		for _, l := range lines {
			item.LogTail = append(item.LogTail, w.red(l, redact.MaxBundleLine))
		}
		w.b.Services = append(w.b.Services, item)
	}
}

// ports adds which exposed ports listen.
func (w *bundleWriter) ports(ports []driver.PortDiagnostics) {
	for _, p := range ports {
		if p.Port < 1 || p.Port > 65535 {
			continue
		}
		if len(w.b.Ports) == bundlePorts {
			w.b.Truncated = true
			break
		}
		w.b.Ports = append(w.b.Ports, protocol.ClaimFailedBodyBundlePortsItem{Service: w.red(p.Service, 128), Port: int64(p.Port), Listening: p.Listening})
	}
}

// disk adds the free space of the workload's filesystems.
func (w *bundleWriter) disk(disks []driver.DiskDiagnostics) {
	for _, dk := range disks {
		if dk.Path == "" {
			continue
		}
		if len(w.b.Disk) == bundleDisks {
			w.b.Truncated = true
			break
		}
		w.b.Disk = append(w.b.Disk, protocol.ClaimFailedBodyBundleDiskItem{Path: w.red(dk.Path, 256), TotalBytes: max(dk.TotalBytes, 0), FreeBytes: max(dk.FreeBytes, 0)})
	}
}

// bootOutput adds what the failed boot printed, when the cause carries it
// (more than one line), as one more service.
func (w *bundleWriter) bootOutput(cause error) {
	if cause == nil {
		return
	}
	if lines := strings.Split(strings.TrimRight(cause.Error(), "\n"), "\n"); len(lines) > 1 {
		if len(w.b.Services) == bundleServices {
			w.b.Truncated = true
		} else {
			if len(lines) > bundleLines {
				lines, w.b.Truncated = lines[len(lines)-bundleLines:], true
			}
			item := protocol.ClaimFailedBodyBundleServicesItem{Name: bootOutputService, State: "failed", LogTail: make([]string, 0, len(lines))}
			for _, l := range lines {
				item.LogTail = append(item.LogTail, w.red(l, redact.MaxBundleLine))
			}
			w.b.Services = append(w.b.Services, item)
		}
	}
}

// deniedEgress adds what the proxy or the resolver refused for the claim.
func (w *bundleWriter) deniedEgress(denied []DeniedEgress) {
	for _, e := range denied {
		if e.Port < 1 || e.Port > 65535 {
			continue
		}
		if len(w.b.DeniedEgress) == bundleDenied {
			w.b.Truncated = true
			break
		}
		item := protocol.ClaimFailedBodyBundleDeniedEgressItem{Host: w.red(e.Host, 256), Port: int64(e.Port), At: protocol.FormatTime(e.At)}
		if e.Platform {
			platform := true
			item.Platform = &platform
		}
		w.b.DeniedEgress = append(w.b.DeniedEgress, item)
	}
}

// trimLogs drops the oldest lines of the longest log until all logs fit.
func trimLogs(b *protocol.ClaimFailedBodyBundle, budget int) {
	total := 0
	for _, s := range b.Services {
		for _, l := range s.LogTail {
			total += len(l) + 4
		}
	}
	for total > budget {
		longest := -1
		for i, s := range b.Services {
			if len(s.LogTail) > 0 && (longest < 0 || len(s.LogTail) > len(b.Services[longest].LogTail)) {
				longest = i
			}
		}
		if longest < 0 {
			return
		}
		total -= len(b.Services[longest].LogTail[0]) + 4
		b.Services[longest].LogTail = b.Services[longest].LogTail[1:]
		b.Truncated = true
	}
}
