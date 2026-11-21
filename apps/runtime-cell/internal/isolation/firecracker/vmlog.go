package firecracker

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// What the backend keeps of a machine past its jail: the tail of its VMM's
// log and the states it went through, one file per destroyed machine under
// StateDir/vmlogs, root's only, token-shaped strings already masked
// (redact.Patterns). The claim's own redactor masks them again when they
// leave the cell in its failure bundle (agent bundleWriter).
const (
	// keptLogBytes is the most of a VMM's log kept (its newest bytes).
	keptLogBytes = 64 << 10
	// keptMachines and keptFor bound the kept files: the newest
	// keptMachines, none older than keptFor.
	keptMachines = 128
	keptFor      = 72 * time.Hour
	// maxStateBytes bounds a live machine's states file: a machine paused
	// and resumed without end stops adding states there, not the cell.
	maxStateBytes = 32 << 10
	// maxDetail is the most of a state's detail (an error) kept.
	maxDetail = 1 << 10
)

func (b *Backend) statesPath(id string) string {
	return filepath.Join(b.cfg.StateDir, "vmstates", id+".jsonl")
}

func (b *Backend) keptDir() string { return filepath.Join(b.cfg.StateDir, "vmlogs") }

// transition records that machine id entered state. Best effort: a state
// that cannot be written never fails the machine.
func (b *Backend) transition(id, state, detail string) {
	p := b.statesPath(id)
	if fi, err := os.Stat(p); err == nil && fi.Size() >= maxStateBytes {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return
	}
	detail, _ = redact.Patterns(detail)
	detail, _ = redact.Clip(detail, maxDetail)
	line, err := json.Marshal(isolation.Transition{At: time.Now().UTC(), State: state, Detail: detail})
	if err != nil {
		return
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600) //nolint:gosec // G304: the backend's own states file
	if err != nil {
		return
	}
	_, _ = f.Write(append(line, '\n'))
	_ = f.Close()
}

func (b *Backend) transitionsOf(id string) []isolation.Transition {
	raw, err := os.ReadFile(b.statesPath(id))
	if err != nil {
		return nil
	}
	var out []isolation.Transition
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		var t isolation.Transition
		if json.Unmarshal(sc.Bytes(), &t) == nil {
			out = append(out, t)
		}
	}
	return out
}

func lastState(ts []isolation.Transition) string {
	if len(ts) == 0 {
		return ""
	}
	return ts[len(ts)-1].State
}

// liveLog is machine id's log as it stands: its transitions and the tail of
// its VMM's log in the jail, masked.
func (b *Backend) liveLog(r *Record) isolation.MachineLog {
	l := isolation.MachineLog{Name: r.Name, ID: r.ID, Org: r.Org, Claim: r.Claim, Transitions: b.transitionsOf(r.ID)}
	raw, _ := readTail(filepath.Join(b.rootDir(r.ID), jailLog), keptLogBytes)
	if int64(len(raw)) >= keptLogBytes {
		l.Truncated = true
	}
	l.VMMLog, _ = redact.Patterns(string(raw))
	return l
}

// readTail is the last n bytes of a file.
func readTail(path string, n int64) ([]byte, error) {
	f, err := os.Open(path) //nolint:gosec // G304: a jail's own log
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	off := max(0, fi.Size()-n)
	buf := make([]byte, fi.Size()-off)
	_, err = f.ReadAt(buf, off)
	return buf, err
}

// keep writes what is known of the machine before its jail goes, then
// prunes the kept files to their bounds. Best effort, as transition is.
func (b *Backend) keep(r Record) {
	l := b.liveLog(&r)
	l.Kept = time.Now().UTC()
	raw, err := json.Marshal(l)
	if err != nil {
		return
	}
	dir := b.keptDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	name := strconv.FormatInt(l.Kept.UnixNano(), 10) + "-" + r.ID + ".json"
	tmp := filepath.Join(dir, "."+name+".tmp")
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		_ = os.Remove(tmp)
		return
	}
	b.pruneKept(l.Kept)
}

// keptFiles are the kept files' names, oldest first (their names start with
// the time they were kept).
func (b *Backend) keptFiles() []string {
	entries, err := os.ReadDir(b.keptDir())
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if n := e.Name(); strings.HasSuffix(n, ".json") && !strings.HasPrefix(n, ".") {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

func keptAt(name string) time.Time {
	ns, err := strconv.ParseInt(strings.SplitN(name, "-", 2)[0], 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(0, ns)
}

// pruneKept drops the kept files older than keptFor, then the oldest past
// keptMachines.
func (b *Backend) pruneKept(now time.Time) {
	files := b.keptFiles()
	for i, n := range files {
		if len(files)-i <= keptMachines && now.Sub(keptAt(n)) <= keptFor {
			break
		}
		_ = os.Remove(filepath.Join(b.keptDir(), n))
	}
}

// MachineLogs is what is known of claim's machines (of org), kept or still
// live, oldest first: each one's states and the tail of its VMM's log.
func (b *Backend) MachineLogs(org, claim string) ([]isolation.MachineLog, error) {
	if org == "" || claim == "" {
		return nil, errors.New("firecracker: machine logs need the org and the claim")
	}
	var out []isolation.MachineLog
	for _, n := range b.keptFiles() {
		raw, err := os.ReadFile(filepath.Join(b.keptDir(), n)) //nolint:gosec // G304: the backend's own directory
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		var l isolation.MachineLog
		if json.Unmarshal(raw, &l) == nil && l.Org == org && l.Claim == claim {
			out = append(out, l)
		}
	}
	rs, err := b.Machines()
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	for i := range rs {
		if rs[i].Org == org && rs[i].Claim == claim {
			out = append(out, b.liveLog(&rs[i]))
		}
	}
	return out, nil
}
