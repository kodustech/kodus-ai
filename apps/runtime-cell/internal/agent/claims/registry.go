package claims

import (
	"errors"
	"sync"
)

var (
	ErrExists = errors.New("claims: claim already held")
	ErrFull   = errors.New("claims: cell is full")
)

// Registry is the claims a cell holds, at most Max.
type Registry struct {
	mu   sync.Mutex
	max  int
	byID map[string]*Claim
}

func NewRegistry(max int) *Registry { return &Registry{max: max, byID: map[string]*Claim{}} }

func (r *Registry) Add(c *Claim) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.byID[c.ID]; ok {
		return ErrExists
	}
	if len(r.byID) >= r.max {
		return ErrFull
	}
	r.byID[c.ID] = c
	return nil
}

func (r *Registry) Get(id string) (*Claim, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.byID[id]
	return c, ok
}

// Remove drops c, and only c: a new claim with the same id stays. It
// reports whether c was dropped.
func (r *Registry) Remove(c *Claim) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.byID[c.ID] == c {
		delete(r.byID, c.ID)
		return true
	}
	return false
}

func (r *Registry) All() []*Claim {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*Claim, 0, len(r.byID))
	for _, c := range r.byID {
		out = append(out, c)
	}
	return out
}

func (r *Registry) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.byID)
}

// Free is how many more claims fit.
func (r *Registry) Free() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return max(r.max-len(r.byID), 0)
}

// CountByState counts the claims in each state.
func (r *Registry) CountByState() map[State]int {
	out := map[State]int{}
	for _, c := range r.All() {
		out[c.State()]++
	}
	return out
}
