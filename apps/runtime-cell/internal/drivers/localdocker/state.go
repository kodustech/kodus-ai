package localdocker

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// StateFile is where the driver keeps what Docker labels cannot hold
// (kodus:expires moves; labels do not), under Config.StateDir.
const StateFile = "local-docker-state.json"

type machineState struct {
	Tags      map[string]string `json:"tags"`
	ExpiresAt time.Time         `json:"expiresAt"`
	// Dir is the checkout the project was last brought up from.
	Dir string `json:"dir,omitempty"`
	// Ports maps "service/port" to the host address it is published on.
	Ports map[string]string `json:"ports,omitempty"`
	// Expose is what the last boot published (the recipe's, or the claim's
	// when the checkout has no recipe); Services and SeedSha feed the
	// manifest; Boot is the last boot or reset timing.
	Expose   []driver.ExposePort `json:"expose,omitempty"`
	Services []string            `json:"services,omitempty"`
	SeedSha  string              `json:"seedSha,omitempty"`
	Boot     *BootReport         `json:"boot,omitempty"`
	// Snapshots maps each named volume of the project to the volume that
	// holds its copy from the first ready boot (data.reset: snapshot).
	Snapshots map[string]string `json:"snapshots,omitempty"`
}

type claimState struct {
	Expose []driver.ExposePort `json:"expose"`
}

type state struct {
	Machines map[string]*machineState `json:"machines"`
	Claims   map[string]*claimState   `json:"claims"`
}

func loadState(path string) (*state, error) {
	s := &state{Machines: map[string]*machineState{}, Claims: map[string]*claimState{}}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, s); err != nil {
		return nil, err
	}
	if s.Machines == nil {
		s.Machines = map[string]*machineState{}
	}
	if s.Claims == nil {
		s.Claims = map[string]*claimState{}
	}
	return s, nil
}

// save writes the whole state through a temp file and a rename, so a crash
// leaves either the old file or the new one.
func (s *state) save(path string) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
