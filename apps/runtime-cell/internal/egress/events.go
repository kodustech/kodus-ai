package egress

import (
	"context"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
)

// Event is one connection the proxy refused (egress.blocked).
type Event struct {
	Seq     int64     `json:"seq"`
	ClaimID string    `json:"claimId,omitempty"`
	Host    string    `json:"host"`
	SNI     string    `json:"sni,omitempty"`
	Port    int       `json:"port"`
	Phase   string    `json:"phase,omitempty"`
	Reason  string    `json:"reason"`
	At      time.Time `json:"at"`
}

// Events is the bounded log of refusals the control port serves.
type Events struct{ log *eventlog.Log[Event] }

func NewEvents(max int) *Events { return &Events{log: eventlog.New[Event](max)} }

func (e *Events) Add(ev Event) {
	e.log.Add(func(seq int64) Event { ev.Seq = seq; return ev })
}

// After returns events with Seq > after, waiting up to wait for one.
func (e *Events) After(ctx context.Context, after int64, wait time.Duration) []Event {
	return e.log.After(ctx, after, wait)
}
