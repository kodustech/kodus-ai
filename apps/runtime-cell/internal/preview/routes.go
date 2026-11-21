// Package preview is the cell's side of preview URLs
// (docs/runtime/preview-urls.md §4): the routes the hub declared
// (preview.route, preview.unroute), the tunnel the cell dials to the preview
// edge (preview.tunnel) and the HTTP/2 server on it, which passes a stream on
// to its claim's observer only when a live route names the stream's preview
// id. It knows no claim state, driver or hub session: the agent hands it a
// route with the upstream to reach.
package preview

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// idPattern is PREVIEW_ID_PATTERN (libs/runtime/contracts/preview.ts).
var idPattern = regexp.MustCompile(protocol.PreviewIDPattern)

// ValidID reports whether s is a preview id, so it may be logged or kept.
func ValidID(s string) bool { return idPattern.MatchString(s) }

// Target is the claim's http expose entry a route serves.
type Target struct {
	Service string
	Port    int
}

// Route is one preview.route: streams of PreviewID go to Upstream (the
// claim's observer preview proxy) for Target until Until.
type Route struct {
	PreviewID string
	ClaimID   string
	Target    Target
	Until     time.Time
	Upstream  http.Handler
}

// ErrOtherClaim refuses a route whose preview id another claim holds.
var ErrOtherClaim = errors.New("preview: the preview id is routed to another claim")

type entry struct {
	Route
	ctx    context.Context
	cancel context.CancelFunc
	active int
}

// Table is the cell's live routes. Removing a route cancels the context its
// open streams run under, so they end at once.
type Table struct {
	clock      clock.Clock
	maxStreams int

	mu      sync.Mutex
	routes  map[string]*entry
	onEmpty func()
}

// NewTable keeps routes on clk; maxStreams bounds one preview's concurrent
// streams (zero: DefaultMaxStreams).
func NewTable(clk clock.Clock, maxStreams int) *Table {
	if maxStreams <= 0 {
		maxStreams = DefaultMaxStreams
	}
	return &Table{clock: clock.Or(clk), maxStreams: maxStreams, routes: map[string]*entry{}}
}

// Set adds a route or moves an existing one's end, target and upstream (the
// hub renews a route with the claim's lease). A preview id of another claim
// is refused.
func (t *Table) Set(r Route) error {
	if !ValidID(r.PreviewID) || r.ClaimID == "" || r.Upstream == nil {
		return errors.New("preview: invalid route")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.routes[r.PreviewID]; ok {
		if e.ClaimID != r.ClaimID {
			return ErrOtherClaim
		}
		e.Route = r
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.routes[r.PreviewID] = &entry{Route: r, ctx: ctx, cancel: cancel}
	return nil
}

// Remove drops the claim's route of previewID and ends its streams; false
// when it held none.
func (t *Table) Remove(previewID, claimID string) bool {
	t.mu.Lock()
	e, ok := t.routes[previewID]
	if !ok || e.ClaimID != claimID {
		t.mu.Unlock()
		return false
	}
	t.dropLocked(previewID, e)
	t.mu.Unlock()
	t.emptied()
	return true
}

// RemoveClaim drops every route of a claim (its release) and ends their
// streams; it returns how many it dropped.
func (t *Table) RemoveClaim(claimID string) int {
	t.mu.Lock()
	n := 0
	for id, e := range t.routes {
		if e.ClaimID == claimID {
			t.dropLocked(id, e)
			n++
		}
	}
	t.mu.Unlock()
	if n > 0 {
		t.emptied()
	}
	return n
}

func (t *Table) dropLocked(id string, e *entry) {
	delete(t.routes, id)
	e.cancel()
}

// Len is the number of routes held, expired ones included until removed.
func (t *Table) Len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.routes)
}

func (t *Table) emptied() {
	t.mu.Lock()
	empty, f := len(t.routes) == 0, t.onEmpty
	t.mu.Unlock()
	if empty && f != nil {
		f()
	}
}

// refusal is why a stream was not admitted.
type refusal string

const (
	refusedNoRoute refusal = "no_route"
	refusedBusy    refusal = "busy"
)

// stream is an admitted stream of a route: its upstream, target and the
// route's context; done gives the slot back.
type stream struct {
	previewID string
	target    Target
	upstream  http.Handler
	ctx       context.Context
	done      func()
}

// admit takes a stream slot of previewID's live route.
func (t *Table) admit(previewID string) (*stream, refusal) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.routes[previewID]
	if !ok || !t.clock.Now().Before(e.Until) {
		return nil, refusedNoRoute
	}
	if e.active >= t.maxStreams {
		return nil, refusedBusy
	}
	e.active++
	var once sync.Once
	return &stream{previewID: previewID, target: e.Target, upstream: e.Upstream, ctx: e.ctx, done: func() {
		once.Do(func() {
			t.mu.Lock()
			e.active--
			t.mu.Unlock()
		})
	}}, ""
}
