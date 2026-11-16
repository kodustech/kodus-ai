package vmsnap

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

const (
	manifestName = "manifest.json"
	// claimedName is a session's manifest once a restore took it: a second
	// restore finds none.
	claimedName = "manifest.claimed"
	// abandonAfter is how long a directory with no manifest (a snapshot
	// that never finished) or a claimed session stays before Sweep takes it.
	abandonAfter = 15 * time.Minute
)

// Store keeps snapshots on the cell's disk, one directory per org
// (OrgKey) and one per snapshot under it:
//
//	<dir>/<org key>/<id>/{manifest.json, vmstate, mem, rootfs.ext4, data.ext4}
//
// Everything is the cell's (root's), the directories 0700. The memory file
// alone is 0444: a restored machine's VMM, chrooted as a user of its own,
// reads it through a hard link in its jail and reaches nothing else here.
type Store struct {
	dir string
	// Chown gives a published file to the cell (tests replace it).
	Chown func(path string, uid, gid int) error
	// Free is the bytes the store's file system has free (tests replace it).
	Free func() (int64, error)
	mu   sync.Mutex
	// verified are the snapshots whose every file this process read back
	// to its digest, by id and the memory file's size and time.
	verified map[string]string
}

// NewStore is the store at dir, made when missing.
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, Chown: os.Lchown, verified: map[string]string{}}
	s.Free = func() (int64, error) { return freeBytes(dir) }
	return s, nil
}

// Dir is the store's directory.
func (s *Store) Dir() string { return s.dir }

// OrgKey is an org's directory name: a digest, so no org id becomes a path.
func OrgKey(org string) string {
	h := sha256.Sum256([]byte("kodus-org:" + org))
	return hex.EncodeToString(h[:12])
}

func (s *Store) snapDir(org, id string) (string, error) {
	if org == "" {
		return "", refuse("a snapshot needs an org")
	}
	if !ValidID(id) {
		return "", refuse("snapshot id %q", id)
	}
	return filepath.Join(s.dir, OrgKey(org), id), nil
}

// NewID is a new snapshot id: random, never derived from a machine.
func NewID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "ksn-" + hex.EncodeToString(b[:]), nil
}

// Stage makes the empty directory of a new snapshot of org; the backend
// moves its files in, then Publish makes it a snapshot.
func (s *Store) Stage(org string) (id, dir string, err error) {
	if id, err = NewID(); err != nil {
		return "", "", err
	}
	if dir, err = s.snapDir(org, id); err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return "", "", err
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		return "", "", err
	}
	return id, dir, nil
}

// Publish makes the staged directory a snapshot: every file of m's shape
// given to the cell with its mode, read once for its digest and synced,
// then the manifest written and synced last.
func (s *Store) Publish(dir string, m Manifest) (Manifest, error) {
	m.Schema = Schema
	m.Files = map[string]File{}
	for _, name := range filesOf(m.Shape) {
		p := filepath.Join(dir, name)
		if err := s.Chown(p, 0, 0); err != nil {
			return Manifest{}, err
		}
		if err := os.Chmod(p, fileMode(name)); err != nil {
			return Manifest{}, err
		}
		var (
			sum  string
			size int64
			err  error
		)
		if unhashed(m.Purpose, name) {
			// A round goes with its claim, on this host, in this process
			// (Open refuses it elsewhere): read back and synced, a heavy
			// environment's memory and disks were most of a 4.5 min write.
			fi, err := os.Stat(p)
			if err != nil {
				return Manifest{}, err
			}
			size = fi.Size()
		} else if sum, size, err = digestAndSync(p); err != nil {
			return Manifest{}, err
		}
		fi, err := os.Stat(p)
		if err != nil {
			return Manifest{}, err
		}
		m.Files[name] = File{Size: size, SHA256: sum, ModUnixNano: fi.ModTime().UnixNano()}
	}
	if err := m.Check(m.Org, m.ID); err != nil {
		return Manifest{}, err
	}
	raw, err := encodeManifest(m)
	if err != nil {
		return Manifest{}, err
	}
	tmp := filepath.Join(dir, manifestName+".tmp")
	if err := writeSynced(tmp, raw); err != nil {
		return Manifest{}, err
	}
	if err := os.Rename(tmp, filepath.Join(dir, manifestName)); err != nil {
		return Manifest{}, err
	}
	if err := syncDir(dir); err != nil {
		return Manifest{}, err
	}
	s.mu.Lock()
	s.verified[m.ID] = memKey(m)
	s.mu.Unlock()
	return m, nil
}

func memKey(m Manifest) string {
	f := m.Files[FileMem]
	return fmt.Sprintf("%d:%d", f.Size, f.ModUnixNano)
}

func digestAndSync(p string) (string, int64, error) {
	f, err := os.Open(p) //nolint:gosec // G304: a file of the store's own directory
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()
	sum, n, err := digestFile(f)
	if err != nil {
		return "", 0, err
	}
	if err := f.Sync(); err != nil {
		return "", 0, err
	}
	return sum, n, nil
}

func digest(p string) (string, error) {
	f, err := os.Open(p) //nolint:gosec // G304: a file of the store's own directory
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	sum, _, err := digestFile(f)
	return sum, err
}

func writeSynced(p string, raw []byte) error {
	f, err := os.OpenFile(p, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o400) //nolint:gosec // G304: the store's own directory
	if err != nil {
		return err
	}
	_, err = f.Write(raw)
	if serr := f.Sync(); err == nil {
		err = serr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func syncDir(dir string) error {
	d, err := os.Open(dir) //nolint:gosec // G304: the store's own directory
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	return d.Sync()
}

// Open is org's snapshot id, checked: its manifest (Check), every file's
// size and modification time as published, the state file's digest every
// time, and every other file's digest once per process (a cell that
// restarted reads each snapshot back once before its first restore).
func (s *Store) Open(org, id string) (Manifest, string, error) {
	return s.open(org, id, manifestName)
}

func (s *Store) open(org, id, name string) (Manifest, string, error) {
	dir, err := s.snapDir(org, id)
	if err != nil {
		return Manifest{}, "", err
	}
	raw, err := os.ReadFile(filepath.Join(dir, name)) //nolint:gosec // G304: the store's own directory, the id checked
	if errors.Is(err, os.ErrNotExist) {
		return Manifest{}, "", refuse("org %q has no snapshot %s", org, id)
	}
	if err != nil {
		return Manifest{}, "", err
	}
	m, err := decodeManifest(raw)
	if err != nil {
		return Manifest{}, "", err
	}
	if err := m.Check(org, id); err != nil {
		return Manifest{}, "", err
	}
	for name, f := range m.Files {
		fi, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			return Manifest{}, "", refuse("snapshot %s: %v", id, err)
		}
		if fi.Size() != f.Size || fi.ModTime().UnixNano() != f.ModUnixNano {
			return Manifest{}, "", refuse("snapshot %s: %s changed since it was published", id, name)
		}
	}
	if sum, err := digest(filepath.Join(dir, FileState)); err != nil || sum != m.Files[FileState].SHA256 {
		return Manifest{}, "", refuse("snapshot %s: the state file is not the one published", id)
	}
	s.mu.Lock()
	ok := s.verified[id] == memKey(m)
	s.mu.Unlock()
	if !ok {
		for name, f := range m.Files {
			if name == FileState {
				continue
			}
			if f.SHA256 == "" {
				return Manifest{}, "", refuse("snapshot %s: a round another process published (%s has no digest)", id, name)
			}
			if sum, err := digest(filepath.Join(dir, name)); err != nil || sum != f.SHA256 {
				return Manifest{}, "", refuse("snapshot %s: %s is not the one published", id, name)
			}
		}
		s.mu.Lock()
		s.verified[id] = memKey(m)
		s.mu.Unlock()
	}
	return m, dir, nil
}

// Claim takes a session snapshot for its one restore: its manifest moves
// aside, so a second Claim (or an Open) finds none. The restore removes the
// snapshot when it is done, and Sweep removes one whose restore died.
func (s *Store) Claim(org, id string) (Manifest, string, error) {
	dir, err := s.snapDir(org, id)
	if err != nil {
		return Manifest{}, "", err
	}
	if err := os.Rename(filepath.Join(dir, manifestName), filepath.Join(dir, claimedName)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Manifest{}, "", refuse("org %q has no snapshot %s to restore (a session restores once)", org, id)
		}
		return Manifest{}, "", err
	}
	m, dir, err := s.open(org, id, claimedName)
	if err == nil && m.Purpose != isolation.PurposeSession {
		// A template is never claimed: put it back.
		_ = os.Rename(filepath.Join(dir, claimedName), filepath.Join(dir, manifestName))
		return Manifest{}, "", refuse("snapshot %s is a template, not a session", id)
	}
	return m, dir, err
}

// Remove deletes org's snapshot id. A machine restored from it keeps
// running: its memory file is a hard link in its jail.
func (s *Store) Remove(org, id string) error {
	dir, err := s.snapDir(org, id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	delete(s.verified, id)
	s.mu.Unlock()
	return os.RemoveAll(dir)
}

// Policy bounds what the store keeps.
type Policy struct {
	// SessionTTL, TemplateTTL and RoundTTL: older snapshots go (zero: no
	// bound). A round goes with its claim; RoundTTL catches one whose claim
	// ended without the cell (a crash): past the longest claim ceiling.
	SessionTTL, TemplateTTL, RoundTTL time.Duration
	// MaxBytes and MaxOrgBytes bound the disk every snapshot, and one
	// org's, takes (zero: no bound); the oldest go first.
	MaxBytes, MaxOrgBytes int64
	// Here retires every snapshot this host can no longer restore (another
	// kit or host); empty: none retired for it.
	Here Here
	// LiveClaim says whether the cell still holds a machine of the claim; a
	// round of a claim it does not hold goes at once (a release the cell
	// missed: a restart of the cell, the hub or the worker), once older than
	// OrphanGrace. Nil: rounds go with their claim or RoundTTL only.
	LiveClaim func(org, claim string) bool
}

// OrphanGrace is how old a round of a claim with no machine must be to go:
// a round restores its machine in place, which is gone for an instant.
const OrphanGrace = time.Minute

// entry is one snapshot directory as Sweep sees it.
type entry struct {
	org, id, dir string
	m            Manifest
	published    bool
	mod          time.Time
	bytes        int64
}

func (s *Store) entries() ([]entry, error) {
	orgs, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	var out []entry
	for _, o := range orgs {
		if !o.IsDir() {
			continue
		}
		snaps, err := os.ReadDir(filepath.Join(s.dir, o.Name()))
		if err != nil {
			return nil, err
		}
		for _, sn := range snaps {
			dir := filepath.Join(s.dir, o.Name(), sn.Name())
			e := entry{org: o.Name(), id: sn.Name(), dir: dir}
			if fi, err := sn.Info(); err == nil {
				e.mod = fi.ModTime()
			}
			if raw, err := os.ReadFile(filepath.Join(dir, manifestName)); err == nil { //nolint:gosec // G304: the store's own directory
				if m, err := decodeManifest(raw); err == nil {
					e.m, e.published = m, true
					e.mod = m.Created
				}
			}
			e.bytes = allocated(dir)
			out = append(out, e)
		}
	}
	return out, nil
}

// Usage is the disk org's snapshots take.
func (s *Store) Usage(org string) (int64, error) {
	es, err := s.entries()
	if err != nil {
		return 0, err
	}
	var n int64
	for i := range es {
		if es[i].org == OrgKey(org) {
			n += es[i].bytes
		}
	}
	return n, nil
}

// Room refuses a snapshot of need bytes that would take org or the store
// over the policy's bounds (after a Sweep).
func (s *Store) Room(org string, need int64, p Policy) error {
	es, err := s.entries()
	if err != nil {
		return err
	}
	var all, mine int64
	for i := range es {
		all += es[i].bytes
		if es[i].org == OrgKey(org) {
			mine += es[i].bytes
		}
	}
	if p.MaxOrgBytes > 0 && mine+need > p.MaxOrgBytes {
		return refuse("org %q has %d bytes of snapshots; %d more is over its %d", org, mine, need, p.MaxOrgBytes)
	}
	if p.MaxBytes > 0 && all+need > p.MaxBytes {
		return refuse("the cell has %d bytes of snapshots; %d more is over its %d", all, need, p.MaxBytes)
	}
	// Whatever the bounds, the file system must hold it: a snapshot the VMM
	// cannot finish writing ends its machine (it never runs on once a
	// create started).
	if s.Free != nil {
		free, err := s.Free()
		if err != nil {
			return err
		}
		if free < need+freeMargin {
			return refuse("the store's file system has %d bytes free; a %d-byte snapshot needs %d more kept free", free, need, freeMargin)
		}
	}
	return nil
}

// freeMargin is what a snapshot leaves free on the store's file system.
const freeMargin = 2 << 30

// Sweep removes what the policy no longer keeps and returns the ids it
// removed: unfinished or claimed snapshots left for abandonAfter, sessions
// and templates past their age, snapshots this host can no longer restore,
// then the oldest until the store and each org are within their bytes.
func (s *Store) Sweep(now time.Time, p Policy) ([]string, error) {
	es, err := s.entries()
	if err != nil {
		return nil, err
	}
	var gone []string
	var errs []error
	keep := es[:0]
	drop := func(e *entry) {
		if err := os.RemoveAll(e.dir); err != nil {
			errs = append(errs, err)
			return
		}
		s.mu.Lock()
		delete(s.verified, e.id)
		s.mu.Unlock()
		gone = append(gone, e.id)
	}
	for i := range es {
		e := &es[i]
		switch {
		case !e.published:
			if now.Sub(e.mod) > abandonAfter {
				drop(e)
				continue
			}
		case e.m.Purpose == isolation.PurposeSession && p.SessionTTL > 0 && now.Sub(e.m.Created) > p.SessionTTL,
			e.m.Purpose == isolation.PurposeTemplate && p.TemplateTTL > 0 && now.Sub(e.m.Created) > p.TemplateTTL,
			e.m.Purpose == isolation.PurposeRound && p.RoundTTL > 0 && now.Sub(e.m.Created) > p.RoundTTL,
			e.m.Purpose == isolation.PurposeRound && p.LiveClaim != nil && now.Sub(e.m.Created) > OrphanGrace && !p.LiveClaim(e.m.Org, e.m.Claim),
			p.Here.Kit != "" && e.m.Kit != p.Here.Kit,
			p.Here.Host != "" && e.m.Host != p.Here.Host:
			drop(e)
			continue
		}
		keep = append(keep, *e)
	}
	sort.Slice(keep, func(i, j int) bool { return keep[i].mod.Before(keep[j].mod) })
	total, byOrg := int64(0), map[string]int64{}
	for i := range keep {
		total += keep[i].bytes
		byOrg[keep[i].org] += keep[i].bytes
	}
	for i := range keep {
		e := &keep[i]
		if !e.published {
			continue // still being written
		}
		over := p.MaxBytes > 0 && total > p.MaxBytes
		orgOver := p.MaxOrgBytes > 0 && byOrg[e.org] > p.MaxOrgBytes
		if !over && !orgOver {
			continue
		}
		drop(e)
		total -= e.bytes
		byOrg[e.org] -= e.bytes
	}
	return gone, errors.Join(errs...)
}

// Latest is org's newest template of key that this host can restore into a
// machine of shape; ok false when there is none.
func (s *Store) Latest(org, key string, here Here, shape isolation.Shape) (Manifest, bool, error) {
	es, err := s.entries()
	if err != nil {
		return Manifest{}, false, err
	}
	var best Manifest
	found := false
	for i := range es {
		e := &es[i]
		if !e.published || e.org != OrgKey(org) || e.m.Org != org || e.m.Purpose != isolation.PurposeTemplate || e.m.Key != key {
			continue
		}
		if e.m.Restorable(here, shape) != nil {
			continue
		}
		if !found || e.m.Created.After(best.Created) {
			best, found = e.m, true
		}
	}
	return best, found, nil
}

// RetireKey removes org's templates of key but keep: a new template of a key
// replaces the others (a new setup). Machines restored from them keep
// running on their hard links.
func (s *Store) RetireKey(org, key, keep string) ([]string, error) {
	return s.removeWhere(org, func(m Manifest) bool {
		return m.Purpose == isolation.PurposeTemplate && m.Key == key && m.ID != keep
	})
}

// RemoveClaim removes the round snapshots of org's claim: they go with it.
func (s *Store) RemoveClaim(org, claim string) ([]string, error) {
	return s.removeWhere(org, func(m Manifest) bool { return m.Purpose == isolation.PurposeRound && m.Claim == claim })
}

func (s *Store) removeWhere(org string, match func(Manifest) bool) ([]string, error) {
	es, err := s.entries()
	if err != nil {
		return nil, err
	}
	var gone []string
	var errs []error
	for i := range es {
		e := &es[i]
		if !e.published || e.org != OrgKey(org) || e.m.Org != org || !match(e.m) {
			continue
		}
		if err := s.Remove(org, e.id); err != nil {
			errs = append(errs, err)
			continue
		}
		gone = append(gone, e.id)
	}
	return gone, errors.Join(errs...)
}
