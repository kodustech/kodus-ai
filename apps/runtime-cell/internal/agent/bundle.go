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
	b := &protocol.ClaimFailedBodyBundle{
		Services:     []protocol.ClaimFailedBodyBundleServicesItem{},
		Ports:        []protocol.ClaimFailedBodyBundlePortsItem{},
		Disk:         []protocol.ClaimFailedBodyBundleDiskItem{},
		DeniedEgress: []protocol.ClaimFailedBodyBundleDeniedEgressItem{},
		CollectedAt:  protocol.FormatTime(a.clock.Now()),
	}
	r := c.Redactor()
	if r == nil {
		r = redact.New()
	}
	red := func(s string, max int) string {
		out, n := r.String(s)
		b.Redactions += int64(n)
		out, cut := redact.Clip(out, max)
		if cut {
			b.Truncated = true
		}
		return out
	}
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
		for i, s := range diag.Services {
			if i == bundleServices {
				b.Truncated = true
				break
			}
			lines := s.Log
			if len(lines) > bundleLines {
				lines, b.Truncated = lines[len(lines)-bundleLines:], true
			}
			item := protocol.ClaimFailedBodyBundleServicesItem{Name: red(s.Name, 128), State: red(s.State, 128), LogTail: make([]string, 0, len(lines))}
			if item.Name == "" {
				item.Name = "unknown"
			}
			for _, l := range lines {
				item.LogTail = append(item.LogTail, red(l, redact.MaxBundleLine))
			}
			b.Services = append(b.Services, item)
		}
		for _, p := range diag.Ports {
			if p.Port < 1 || p.Port > 65535 {
				continue
			}
			if len(b.Ports) == bundlePorts {
				b.Truncated = true
				break
			}
			b.Ports = append(b.Ports, protocol.ClaimFailedBodyBundlePortsItem{Service: red(p.Service, 128), Port: int64(p.Port), Listening: p.Listening})
		}
		for _, dk := range diag.Disk {
			if dk.Path == "" {
				continue
			}
			if len(b.Disk) == bundleDisks {
				b.Truncated = true
				break
			}
			b.Disk = append(b.Disk, protocol.ClaimFailedBodyBundleDiskItem{Path: red(dk.Path, 256), TotalBytes: max(dk.TotalBytes, 0), FreeBytes: max(dk.FreeBytes, 0)})
		}
	}
	if cause != nil {
		if lines := strings.Split(strings.TrimRight(cause.Error(), "\n"), "\n"); len(lines) > 1 {
			if len(b.Services) == bundleServices {
				b.Truncated = true
			} else {
				if len(lines) > bundleLines {
					lines, b.Truncated = lines[len(lines)-bundleLines:], true
				}
				item := protocol.ClaimFailedBodyBundleServicesItem{Name: bootOutputService, State: "failed", LogTail: make([]string, 0, len(lines))}
				for _, l := range lines {
					item.LogTail = append(item.LogTail, red(l, redact.MaxBundleLine))
				}
				b.Services = append(b.Services, item)
			}
		}
	}
	if src := a.cfg.DeniedEgress; src != nil {
		for _, e := range src.Denied(c.ID) {
			if e.Port < 1 || e.Port > 65535 {
				continue
			}
			if len(b.DeniedEgress) == bundleDenied {
				b.Truncated = true
				break
			}
			item := protocol.ClaimFailedBodyBundleDeniedEgressItem{Host: red(e.Host, 256), Port: int64(e.Port), At: protocol.FormatTime(e.At)}
			if e.Platform {
				platform := true
				item.Platform = &platform
			}
			b.DeniedEgress = append(b.DeniedEgress, item)
		}
	}
	trimLogs(b, bundleLogBytes)
	return b
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
