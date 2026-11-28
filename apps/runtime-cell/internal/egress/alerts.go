package egress

import (
	"net/http"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
)

// Alert is a security event the proxy raises for the cell agent, in the
// injector's feed format (GET /v1/alerts, the same continuity headers): a
// claim's secret placeholder sent over plain HTTP (ReasonPlaceholderLeak).
// The agent marks the claim compromised, as for an injector alert.
type Alert struct {
	Seq     int64     `json:"seq"`
	ClaimID string    `json:"claimId"`
	Host    string    `json:"host"`
	Kind    string    `json:"kind"`
	At      time.Time `json:"at"`
}

// Alerts is the bounded feed of the proxy's alerts.
type Alerts struct{ log *eventlog.Log[Alert] }

func NewAlerts(capacity int) *Alerts { return &Alerts{log: eventlog.New[Alert](capacity)} }

// PlaceholderLeak records a claim's placeholder refused over plain HTTP to
// host; Proxy.OnPlaceholderLeak calls it.
func (a *Alerts) PlaceholderLeak(claimID, host string, at time.Time) {
	a.log.Add(func(seq int64) Alert {
		return Alert{Seq: seq, ClaimID: claimID, Host: host, Kind: ReasonPlaceholderLeak, At: at.UTC()}
	})
}

// Handler serves the feed (long poll after a sequence number).
func (a *Alerts) Handler() http.HandlerFunc { return a.log.Handler() }
