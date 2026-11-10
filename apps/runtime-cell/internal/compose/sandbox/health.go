package sandbox

import (
	"time"
)

// Docker's defaults for a healthcheck that does not say.
const (
	defaultHealthInterval = 30 * time.Second
	defaultHealthRetries  = 3
)

// maxFastStart bounds how long a service is probed at the fast cadence.
// Past it the service's own interval applies, as without the rewrite.
const maxFastStart = 30 * time.Second

// fastStartHealth makes Docker probe a starting service every `every`
// instead of every interval of its own, until it first passes. Compose's
// --wait and depends_on service_healthy act on that first pass: a recipe's
// "interval: 2s" otherwise costs up to 2 s per service on every boot and on
// every round's reset, with the service already up.
//
// It is Docker's start_period/start_interval: probes in the start period
// run every start_interval and their failures do not count, and the first
// pass ends it. The period is the service's own budget (interval ×
// retries), at most maxFastStart, so a service that never passes is
// declared unhealthy that much later than before; one that passes is
// probed and judged as the file says from then on. What the probe runs,
// and what the service does, do not change.
//
// A healthcheck that sets either key itself, is disabled, or whose
// interval or retries the cell does not read is left as written.
func fastStartHealth(svc map[string]any, every time.Duration) {
	hc, ok := svc["healthcheck"].(map[string]any)
	if !ok || every <= 0 {
		return
	}
	if d, _ := hc["disable"].(bool); d {
		return
	}
	if _, ok := hc["start_period"]; ok {
		return
	}
	if _, ok := hc["start_interval"]; ok {
		return
	}
	switch t := hc["test"].(type) {
	case string:
		if t == "" || t == "NONE" {
			return
		}
	case []any:
		if len(t) == 0 || t[0] == "NONE" {
			return
		}
	default:
		return // no test of its own: the image's, which the cell does not see
	}
	interval := defaultHealthInterval
	if v, ok := hc["interval"]; ok {
		s, _ := v.(string)
		d, err := time.ParseDuration(s)
		if err != nil || d <= 0 {
			return
		}
		interval = d
	}
	retries := defaultHealthRetries
	if v, ok := hc["retries"]; ok {
		n, _ := v.(int)
		if n <= 0 {
			return
		}
		retries = n
	}
	if interval <= every {
		return
	}
	period := min(interval*time.Duration(retries), maxFastStart)
	hc["start_period"] = period.String()
	hc["start_interval"] = every.String()
}
