// Package provenance is what the cell remembers about where its machines
// and images came from (S-52): which machines ran PR code, which images this
// cell baked from a default-branch commit, which of those is each
// environment's last, and which environments have a bake in progress.
//
// It decides nothing: the agent asks it before a machine becomes an image or
// a pool machine, and before a claim boots from a bake. It holds ids only,
// behind its own lock.
package provenance

import "sync"

// LatestImage names the environment's last bake in this cell.
const LatestImage = "latest"

// Image is a bake this cell made: the environment and the commit it is of.
type Image struct {
	OrgID, EnvironmentID, SHA string
}

type envKey struct{ orgID, environmentID string }

// Record is the cell's provenance. The zero value is not usable: New.
type Record struct {
	mu sync.Mutex
	// tainted are machines that ran PR code: never an image, a snapshot nor
	// a pool machine.
	tainted map[string]bool
	// baked are the images this cell baked from a default-branch commit,
	// the only ones a pool takes; latest is each environment's last.
	baked  map[string]Image
	latest map[envKey]string
	// active are the environments with a bake in progress.
	active map[envKey]bool
}

func New() *Record {
	return &Record{tainted: map[string]bool{}, baked: map[string]Image{}, latest: map[envKey]string{}, active: map[envKey]bool{}}
}

// Taint marks a machine that ran PR code.
func (r *Record) Taint(machineID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tainted[machineID] = true
}

// Untaint forgets a destroyed machine (ids are never reused).
func (r *Record) Untaint(machineID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.tainted, machineID)
}

func (r *Record) Tainted(machineID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tainted[machineID]
}

// Add records an image this cell baked; latest makes it its environment's
// last bake.
func (r *Record) Add(imageID string, img Image, latest bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.baked[imageID] = img
	if latest {
		r.latest[envKey{img.OrgID, img.EnvironmentID}] = imageID
	}
}

// Baked is the image as this cell baked it; false for any other.
func (r *Record) Baked(imageID string) (Image, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	img, ok := r.baked[imageID]
	return img, ok
}

// Latest is the environment's last bake in this cell, or "".
func (r *Record) Latest(orgID, environmentID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.latest[envKey{orgID, environmentID}]
}

// Resolve reads LatestImage as the environment's last bake ("" before any),
// leaves any other id as it is, and says whether this cell baked the result.
// One read: the last bake and its record are of the same instant.
func (r *Record) Resolve(orgID, environmentID, imageID string) (resolved string, img Image, baked bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if imageID == LatestImage {
		imageID = r.latest[envKey{orgID, environmentID}]
	}
	img, baked = r.baked[imageID]
	return imageID, img, baked
}

// Reserve takes the environment's one bake in progress; false while another
// holds it. finish gives it back, once.
func (r *Record) Reserve(orgID, environmentID string) (finish func(), ok bool) {
	k := envKey{orgID, environmentID}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active[k] {
		return nil, false
	}
	r.active[k] = true
	var once sync.Once
	return func() { once.Do(func() { r.mu.Lock(); delete(r.active, k); r.mu.Unlock() }) }, true
}

// Images are the ids of the images this cell baked.
func (r *Record) Images() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.baked))
	for id := range r.baked {
		out = append(out, id)
	}
	return out
}

// Counts is how many machines are tainted, images baked and bakes in
// progress.
func (r *Record) Counts() (tainted, baked, active int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.tainted), len(r.baked), len(r.active)
}
