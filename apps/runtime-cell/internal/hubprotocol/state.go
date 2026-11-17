// Package hubprotocol is what a cell host keeps of the hub its cell last
// reached: the protocol the hub chose at hello and, from a hub that names it
// (the hello ack's cellProtocols), the cell protocols it accepts. The agent
// writes it after every accepted hello (internal/agent); `cell update`
// (internal/cellupdate) reads it to refuse a release that hub would refuse
// (the skew policy, docs/runtime/cell-distribution.md). It holds no secret.
package hubprotocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// StateName is the file under the cell's -state-dir.
const StateName = "hub-protocol.state"

// maxStateBytes bounds what Load reads: the file is a few dozen bytes.
const maxStateBytes = 4 << 10

// Range is a span of protocol versions, both ends included.
type Range struct {
	Min int64 `json:"min"`
	Max int64 `json:"max"`
}

// State is what the hub said in its last hello ack.
type State struct {
	// Version is the protocol the hub chose for the session.
	Version int64 `json:"version"`
	// Accepts is the ack's cellProtocols: the cell protocols the hub
	// accepts at hello. Nil from a hub that does not name them.
	Accepts *Range `json:"accepts,omitempty"`
	// At is when the hub acked.
	At time.Time `json:"at"`
}

// Accepted is the range of cell protocols the hub accepts, and whether the
// hub named it. A hub that names none predates the field, and every such hub
// speaks protocol 1: it is taken to speak the version it chose and, as the
// skew policy says, to accept one protocol older at most.
func (s State) Accepted() (r Range, named bool) {
	if s.Accepts != nil {
		return *s.Accepts, true
	}
	return Range{Min: max(s.Version-1, 1), Max: s.Version}, false
}

func (s State) check() error {
	if s.Version < 1 {
		return errors.New("no protocol version")
	}
	if a := s.Accepts; a != nil && (a.Min < 1 || a.Max < a.Min) {
		return fmt.Errorf("accepted range v%d to v%d is not one", a.Min, a.Max)
	}
	return nil
}

// Save writes s to path atomically (a temporary file renamed over it), 0600.
func Save(path string, s State) error {
	if err := s.check(); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+StateName+".tmp-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	// CreateTemp already makes it 0600; said again so a change there cannot widen it.
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return nil
}

// Load reads the state at path. No file: ok false and no error (the cell
// never reached a hub). A file that does not read as a state is an error
// naming it, never taken for none.
func Load(path string) (s State, ok bool, err error) {
	f, err := os.Open(path) //nolint:gosec // G304: the cell's state dir, named by its config
	if errors.Is(err, os.ErrNotExist) {
		return State{}, false, nil
	}
	if err != nil {
		return State{}, false, err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, maxStateBytes+1))
	if err != nil {
		return State{}, false, fmt.Errorf("%s: %w", path, err)
	}
	if len(b) > maxStateBytes {
		return State{}, false, fmt.Errorf("%s: larger than %d bytes", path, maxStateBytes)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		return State{}, false, fmt.Errorf("%s: %w", path, err)
	}
	if err := s.check(); err != nil {
		return State{}, false, fmt.Errorf("%s: %w", path, err)
	}
	return s, true, nil
}
