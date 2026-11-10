package agent

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

type agentMetrics struct {
	claims               *metrics.Vec
	claimsReaped         *metrics.Vec
	steps                *metrics.Vec
	browserExplorations  *metrics.Vec
	stepConflicts        *metrics.Vec
	bakes                *metrics.Vec
	cleanupsFailed       *metrics.Vec
	alerts               *metrics.Vec
	alertSourceAvailable *metrics.Vec
	alertSourceFailures  *metrics.Vec
	pool                 *metrics.Vec
	sqlObservers         *metrics.Vec
	sqlObserverDuration  *metrics.Vec
}

func newAgentMetrics(reg *metrics.Registry) agentMetrics {
	return agentMetrics{
		claims:               reg.Gauge("cell_claims", "Claims the cell holds, by state.", "state"),
		claimsReaped:         reg.Counter("cell_claims_reaped_total", "Claims the cell tore down without a claim.release, by reason.", "reason"),
		steps:                reg.Counter("cell_steps_total", "Steps run, by kind and outcome.", "kind", "outcome"),
		browserExplorations:  reg.Counter("cell_browser_explorations_total", "Browser exploration completions, by observed, blocked, timeout, unavailable or failed outcome; cancelled steps are excluded.", "outcome"),
		stepConflicts:        reg.Counter("cell_step_conflicts_total", "Steps refused because their stepId was seen with another command (S-30)."),
		bakes:                reg.Counter("cell_image_bakes_total", "Image bakes, by outcome.", "outcome"),
		cleanupsFailed:       reg.Counter("cell_claim_cleanup_errors_total", "Errors tearing a claim down (machines, network, egress policy)."),
		alerts:               reg.Counter("cell_exfiltration_alerts_total", "Injector alerts: a claim's credential or bait left for a host it was not for.", "kind"),
		alertSourceAvailable: reg.Gauge("cell_alert_source_available", "Whether the configured alert source has verified continuity; zero until negotiated or while unavailable."),
		alertSourceFailures:  reg.Counter("cell_alert_source_failures_total", "Alert source failures, by closed continuity or availability reason.", "reason"),
		pool:                 reg.Counter("cell_pool_machines_total", "Warm pool machines, by outcome: created, failed, adopted, discarded.", "outcome"),
		sqlObservers:         reg.Counter("cell_sql_observer_provisions_total", "Managed SQL observer provisioning attempts, by closed outcome.", "outcome"),
		sqlObserverDuration:  reg.Counter("cell_sql_observer_provision_duration_ms_total", "Cumulative managed SQL observer provisioning time in milliseconds."),
	}
}
