package isolation

import "time"

// Machine states a Transition names (a backend's own record of a machine:
// firecracker's vmlog.go).
const (
	StateCreated     = "created"
	StateRestoring   = "restoring"
	StateLaunched    = "launched"
	StateRunning     = "running"
	StatePaused      = "paused"
	StateSnapshotted = "snapshotted"
	StateFailed      = "failed"
	// StateExited: the VMM was gone before Destroy ended it (it crashed, or
	// the kernel killed it).
	StateExited    = "exited"
	StateDestroyed = "destroyed"
)

// Transition is one state a machine entered, and when.
type Transition struct {
	At     time.Time `json:"at"`
	State  string    `json:"state"`
	Detail string    `json:"detail,omitempty"`
}

// MachineLog is what is known of one machine's VMM: its transitions, oldest
// first, and the tail of its log. Kept is when its jail went (zero while
// the machine still is).
type MachineLog struct {
	Name        string       `json:"name"`
	ID          string       `json:"id"`
	Org         string       `json:"org,omitempty"`
	Claim       string       `json:"claim,omitempty"`
	Kept        time.Time    `json:"kept,omitzero"`
	Transitions []Transition `json:"transitions"`
	VMMLog      string       `json:"vmmLog"`
	Truncated   bool         `json:"truncated,omitempty"`
}

// MachineLogReader is a backend that keeps its machines' logs past them:
// what is known of a claim's machines (of org), kept or still live, oldest first.
type MachineLogReader interface {
	MachineLogs(org, claim string) ([]MachineLog, error)
}
