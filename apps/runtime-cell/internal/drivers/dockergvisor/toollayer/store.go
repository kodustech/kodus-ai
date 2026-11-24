package toollayer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Config sizes and places the store. Zero limits take the design's defaults.
type Config struct {
	// Root is the cell's tool layer directory (WorkDir/toollayers).
	Root string

	MaxLayerBytes int64
	MaxOrgBytes   int64
	MaxOrgLayers  int
	MaxCellBytes  int64
	MaxEntries    int

	// Now is injectable for the 24 h, 7 day and 30 day rules.
	Now func() time.Time
}

// Store is the per-org, content-addressed layer store. Every path below Root
// is derived from an org id by hashing it, and from digests this package
// computed or validated as hex; a caller never supplies one.
//
//	o-<hash(org)>/files/<sha256>             the org's file store
//	o-<hash(org)>/layers/<digest>/tree/      hard links into files/, 0555/0444
//	o-<hash(org)>/layers/<digest>/layer.json
//	o-<hash(org)>/layers/<digest>/used       mtime = last mount
//	o-<hash(org)>/keys/<key>                 the digest; mtime = last use
//	o-<hash(org)>/misses/<key>               U9 miss record
//	o-<hash(org)>/staging/                   extractions in flight (0700)
type Store struct {
	cfg Config

	// mu serializes everything that changes the on-disk layout. Hashing and
	// extraction run outside it.
	mu       sync.Mutex
	holds    map[string]int
	verified map[string]time.Time
}

// New opens the store, creating Root as one of the cell's private
// directories and clearing extractions a crash left behind.
func New(cfg Config) (*Store, error) {
	if cfg.Root == "" {
		return nil, errors.New("toollayer: no root directory")
	}
	if cfg.MaxLayerBytes <= 0 {
		cfg.MaxLayerBytes = DefaultMaxLayerBytes
	}
	if cfg.MaxOrgBytes <= 0 {
		cfg.MaxOrgBytes = DefaultMaxOrgBytes
	}
	if cfg.MaxOrgLayers <= 0 {
		cfg.MaxOrgLayers = DefaultMaxOrgLayers
	}
	if cfg.MaxCellBytes <= 0 {
		cfg.MaxCellBytes = DefaultMaxCellBytes
	}
	if cfg.MaxEntries <= 0 {
		cfg.MaxEntries = DefaultMaxEntries
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	root, err := filepath.Abs(cfg.Root)
	if err != nil {
		return nil, err
	}
	cfg.Root = root
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	if err := realDir(root); err != nil {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if sys, ok := sysOf(info); ok && sys.uid != os.Geteuid() {
		return nil, fmt.Errorf("toollayer: %s is owned by uid %d, not the cell's (%d)", root, sys.uid, os.Geteuid())
	}
	if err := os.Chmod(root, 0o700); err != nil { //nolint:gosec // G302: the store root is a directory and needs its search bit; 0700 is owner-only
		return nil, err
	}
	s := &Store{cfg: cfg, holds: map[string]int{}, verified: map[string]time.Time{}}
	for _, od := range s.orgDirs() {
		if err := removeTree(filepath.Join(od, "staging")); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Root is the store's directory, absolute.
func (s *Store) Root() string { return s.cfg.Root }

// OrgDir is the org's directory. It is a function of the org id alone.
func (s *Store) OrgDir(org string) string {
	sum := sha256.Sum256([]byte(org))
	return filepath.Join(s.cfg.Root, "o-"+hex.EncodeToString(sum[:16]))
}

func (s *Store) orgDirs() []string {
	des, _ := os.ReadDir(s.cfg.Root)
	var out []string
	for _, d := range des {
		if d.IsDir() && strings.HasPrefix(d.Name(), "o-") {
			out = append(out, filepath.Join(s.cfg.Root, d.Name()))
		}
	}
	return out
}

func (s *Store) ensureOrg(org string) (string, error) {
	if org == "" {
		return "", errors.New("toollayer: no org")
	}
	od := s.OrgDir(org)
	for _, sub := range []string{"files", "layers", "keys", "misses", "staging"} {
		if err := os.MkdirAll(filepath.Join(od, sub), 0o700); err != nil {
			return "", err
		}
	}
	if err := realDir(od); err != nil {
		return "", err
	}
	return od, nil
}

// realDir is an Lstat check: p exists, is a directory and is not a link
// (MkdirAll and Chmod would follow one).
func realDir(p string) error {
	info, err := os.Lstat(p) //nolint:gosec // G703: Lstat only inspects p (never follows or modifies); p is the store root or an org dir derived from a sha256 of the org id
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("toollayer: %s is not a real directory", p)
	}
	return nil
}

// IngestInput is one builder's output.
type IngestInput struct {
	Org         string
	Key         string
	ImageDigest string
	// Binary is the CLI's binary name, looked up like the install script does.
	Binary    string
	Tar       io.Reader
	Integrity Integrity
}

// Ingest turns a builder's tar stream into a layer and points the key at it,
// or refuses the whole layer and leaves nothing behind.
func (s *Store) Ingest(ctx context.Context, in IngestInput) (Layer, error) {
	if err := ctx.Err(); err != nil {
		return Layer{}, err
	}
	if !imageDigestRe.MatchString(in.ImageDigest) {
		return Layer{}, ErrNoImageDigest
	}
	if !hexRe.MatchString(in.Key) {
		return Layer{}, errors.New("toollayer: key is not a sha256 hex")
	}
	if in.Binary == "" || in.Binary == "." || in.Binary == ".." || strings.ContainsAny(in.Binary, "/\x00") {
		return Layer{}, errors.New("toollayer: binary must be a bare name")
	}
	if in.Integrity.SignaturesInvalid > 0 {
		return Layer{}, refused("invalid_signature", fmt.Sprintf("%d packages", in.Integrity.SignaturesInvalid))
	}
	od, err := s.ensureOrg(in.Org)
	if err != nil {
		return Layer{}, err
	}
	stage, err := os.MkdirTemp(filepath.Join(od, "staging"), "x-")
	if err != nil {
		return Layer{}, err
	}
	defer func() { _ = removeTree(stage) }() // best-effort: staging is also swept at start-up

	ex, err := extract(ctx, in.Tar, stage, s.cfg.MaxLayerBytes, s.cfg.MaxEntries)
	if err != nil {
		return Layer{}, err
	}
	blobs := filepath.Join(stage, "blobs")
	rel, interpreter, err := findEntry(ex.entries, in.Binary, func(sha string) ([]byte, error) {
		f, err := os.Open(filepath.Join(blobs, sha)) //nolint:gosec // G304: sha is the hex digest extract computed itself, a file name under this layer's own staging dir
		if err != nil {
			return nil, err
		}
		defer func() { _ = f.Close() }() // read-only: a close error loses nothing
		b := make([]byte, 4096)
		n, err := io.ReadFull(f, b)
		if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
			return nil, err
		}
		return b[:n], nil
	})
	if err != nil {
		return Layer{}, err
	}
	if err := ctx.Err(); err != nil {
		return Layer{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	layer := Layer{
		Digest: layerDigest(ex.entries), Key: in.Key, ImageDigest: in.ImageDigest, BuiltAt: s.cfg.Now().UTC(),
		BinaryPath: rel, Interpreter: interpreter, Bytes: ex.bytes, Integrity: in.Integrity,
	}
	layerPath := filepath.Join(od, "layers", layer.Digest)
	if _, err := os.Lstat(filepath.Join(layerPath, "layer.json")); err == nil {
		// Same content already stored: only the key moves.
		existing, rerr := readLayer(layerPath)
		if rerr == nil {
			s.touch(filepath.Join(layerPath, "used"))
			return existing, s.swapKey(od, in.Key, layer.Digest)
		}
		return Layer{}, rerr
	}
	if layer.Bytes > s.cfg.MaxOrgBytes || layer.Bytes > s.cfg.MaxCellBytes {
		return Layer{}, refused("too_large", "the layer does not fit its org or cell budget alone")
	}
	if err := s.evictToFit(in.Org, layer.Bytes); err != nil {
		return Layer{}, err
	}
	if err := s.assemble(od, stage, ex, &layer); err != nil {
		return Layer{}, err
	}
	// A leftover directory of a crashed ingest has no layer.json: clear it
	// before taking its name.
	if err := removeTree(layerPath); err != nil {
		return Layer{}, err
	}
	if err := os.Rename(filepath.Join(stage, "layer"), layerPath); err != nil {
		return Layer{}, err
	}
	if err := s.writeLayerJSON(layerPath, layer); err != nil {
		_ = removeTree(layerPath) // best-effort: the write error is returned
		return Layer{}, err
	}
	s.touch(filepath.Join(layerPath, "used"))
	if err := s.swapKey(od, in.Key, layer.Digest); err != nil {
		return Layer{}, err
	}
	return layer, nil
}

// assemble moves the blobs into files/ (or keeps the file the org already
// has), links stage/layer/tree to them, normalizes directory modes and fills
// in the fingerprints. It runs under mu so GC never sees a file without a link.
func (s *Store) assemble(od, stage string, ex *extraction, layer *Layer) error {
	files := filepath.Join(od, "files")
	treeDir := filepath.Join(stage, "layer", "tree")
	if err := os.MkdirAll(treeDir, 0o700); err != nil {
		return err
	}
	for _, e := range ex.entries {
		if e.Type != "file" {
			continue
		}
		dst := filepath.Join(files, e.SHA256)
		if info, err := os.Lstat(dst); err == nil && info.Mode().IsRegular() && info.Size() == e.Size {
			continue
		}
		if err := os.Rename(filepath.Join(stage, "blobs", e.SHA256), dst); err != nil {
			return err
		}
	}
	for _, e := range ex.entries { // sorted: a parent precedes its children
		p := filepath.Join(treeDir, filepath.FromSlash(e.Path))
		var err error
		switch e.Type {
		case "dir":
			err = os.Mkdir(p, 0o700)
		case "symlink":
			err = os.Symlink(e.Target, p)
		case "file":
			err = os.Link(filepath.Join(files, e.SHA256), p)
		}
		if err != nil {
			return err
		}
	}
	for i := len(ex.entries) - 1; i >= 0; i-- { // deepest first
		if e := ex.entries[i]; e.Type == "dir" {
			if err := os.Chmod(filepath.Join(treeDir, filepath.FromSlash(e.Path)), 0o555); err != nil { //nolint:gosec // G302: layer trees are read-only (0555/0444) by design; the sandbox user binds them read-only
				return err
			}
		}
	}
	if err := os.Chmod(treeDir, 0o555); err != nil { //nolint:gosec // G302: the tree root is a read-only directory (0555) by design; it is bound read-only into the sandbox
		return err
	}
	// Fingerprints last: chmod and linking change ctime.
	layer.Entries = make([]Entry, len(ex.entries))
	copy(layer.Entries, ex.entries)
	for i := range layer.Entries {
		if layer.Entries[i].Type != "file" {
			continue
		}
		info, err := os.Lstat(filepath.Join(treeDir, filepath.FromSlash(layer.Entries[i].Path)))
		if err != nil {
			return err
		}
		fp := fingerprintOf(info)
		layer.Entries[i].FP = &fp
	}
	return os.Chmod(filepath.Join(stage, "layer"), 0o700) //nolint:gosec // G302: a directory, which needs its search bit; owner-only
}

// layerDigest is the sha256 of the sorted canonical manifest: path, type,
// normalized mode, size, file sha256 or link target. The fingerprint is
// local to the host and not part of it.
func layerDigest(entries []Entry) string {
	sorted := make([]Entry, len(entries))
	copy(sorted, entries)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path })
	h := sha256.New()
	for _, e := range sorted {
		line, _ := json.Marshal(struct {
			P string `json:"p"`
			T string `json:"t"`
			M uint32 `json:"m"`
			S int64  `json:"s"`
			H string `json:"h,omitempty"`
			L string `json:"l,omitempty"`
		}{e.Path, e.Type, e.Mode, e.Size, e.SHA256, e.Target})
		h.Write(line)
		h.Write([]byte{'\n'})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func readLayer(layerPath string) (Layer, error) {
	raw, err := os.ReadFile(filepath.Join(layerPath, "layer.json")) //nolint:gosec // G304: layerPath is od/layers/<digest> with a sha256 hex digest, and the name is a constant
	if err != nil {
		return Layer{}, err
	}
	var l Layer
	if err := json.Unmarshal(raw, &l); err != nil {
		return Layer{}, err
	}
	return l, nil
}

func (s *Store) writeLayerJSON(layerPath string, l Layer) error {
	raw, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(layerPath, "layer.json", raw, 0o444)
}

// writeAtomic writes dir/name through a temp file in the same directory,
// fsyncs it, renames it into place and fsyncs the directory.
func writeAtomic(dir, name string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(dir, "."+name+".tmp-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(data)
	if err == nil {
		err = f.Chmod(mode)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, filepath.Join(dir, name)) //nolint:gosec // G703: dir is a store directory and name a sha256 hex key or a constant, never raw request data
	}
	if err != nil {
		_ = os.Remove(tmp) //nolint:gosec // G703: tmp is the name os.CreateTemp returned inside dir
		return err
	}
	// Syncing the directory narrows the crash window; a filesystem that
	// cannot is no reason to fail a write that already landed.
	if d, derr := os.Open(dir); derr == nil { //nolint:gosec // G703: dir is the store-owned directory writeAtomic just wrote into (callers pass od/<fixed name> or a layer path), never request data
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

func (s *Store) swapKey(od, key, digest string) error {
	if err := writeAtomic(filepath.Join(od, "keys"), key, []byte(digest+"\n"), 0o600); err != nil {
		return err
	}
	s.touch(filepath.Join(od, "keys", key)) // mtime is the key's last use
	return nil
}

func (s *Store) touch(p string) {
	now := s.cfg.Now()
	if f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o600); err == nil { //nolint:gosec // G304: p is od/keys/<sha256 hex key> or <layer>/used, built from validated components
		_ = f.Close()
	}
	_ = os.Chtimes(p, now, now) // best-effort: a stale mtime only makes GC earlier
}

// Hit is a verified layer, held against GC until Release.
type Hit struct {
	Layer
	// TreePath is the host directory to bind read-only; it was built from a
	// digest this package verified, through real directories only.
	TreePath string
	release  func()
}

// Release lets GC and eviction take the layer again; safe to call twice.
func (h *Hit) Release() {
	if h.release != nil {
		h.release()
	}
}

func (s *Store) holdKey(od, digest string) string { return od + "/" + digest }

// Hold keeps a layer out of GC and LRU eviction until release is called
// (the sandbox that mounted it lives that long). Holds are memory only: a
// cell restart ends every sandbox.
func (s *Store) Hold(org, digest string) (release func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.holdLocked(s.OrgDir(org), digest)
}

func (s *Store) holdLocked(od, digest string) func() {
	k := s.holdKey(od, digest)
	s.holds[k]++
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.holds[k]--; s.holds[k] <= 0 {
				delete(s.holds, k)
			}
		})
	}
}

// Lookup resolves an org's key to a verified, held layer, or a MissError.
func (s *Store) Lookup(ctx context.Context, org, key string) (*Hit, error) {
	if org == "" || !hexRe.MatchString(key) {
		return nil, &MissError{Reason: "no_key"}
	}
	od := s.OrgDir(org)
	raw, err := os.ReadFile(filepath.Join(od, "keys", key)) //nolint:gosec // G304: key passed hexRe above, so it is one path element
	digest := strings.TrimSpace(string(raw))
	if err != nil || !hexRe.MatchString(digest) {
		return nil, &MissError{Reason: "no_key"}
	}
	layerPath := filepath.Join(od, "layers", digest)

	s.mu.Lock()
	if _, err := os.Lstat(filepath.Join(layerPath, "layer.json")); err != nil { //nolint:gosec // G703: layerPath is od/layers/<digest> with a sha256 hex digest (hexRe above); Lstat only inspects
		s.mu.Unlock()
		return nil, &MissError{Reason: "evicted"}
	}
	release := s.holdLocked(od, digest)
	s.mu.Unlock()

	layer, err := s.verify(ctx, od, digest)
	if err != nil {
		release()
		var corrupt *corruptError
		if errors.As(err, &corrupt) {
			s.mu.Lock()
			s.evictLocked(od, digest, corrupt.badFiles)
			s.mu.Unlock()
			return nil, &MissError{Reason: "corrupt"}
		}
		return nil, err
	}
	s.mu.Lock()
	s.touch(filepath.Join(layerPath, "used"))
	s.touch(filepath.Join(od, "keys", key))
	s.mu.Unlock()
	return &Hit{Layer: layer, TreePath: filepath.Join(layerPath, "tree"), release: release}, nil
}

// evictLocked removes a layer, the keys that point at it and, for a layer
// found corrupt, the names in files/ whose shared inode was the tampered one
// (a rebuild must not link it again).
func (s *Store) evictLocked(od, digest string, badFiles []string) {
	for _, name := range badFiles {
		_ = os.Remove(filepath.Join(od, "files", name)) // best-effort: GC removes what is left
	}
	if des, err := os.ReadDir(filepath.Join(od, "keys")); err == nil {
		for _, d := range des {
			//nolint:gosec // G304: d.Name() comes from ReadDir, one path element under od/keys
			if b, err := os.ReadFile(filepath.Join(od, "keys", d.Name())); err == nil && strings.TrimSpace(string(b)) == digest {
				_ = os.Remove(filepath.Join(od, "keys", d.Name())) // best-effort: GC removes what is left
			}
		}
	}
	delete(s.verified, s.holdKey(od, digest))
	_ = removeTree(filepath.Join(od, "layers", digest)) // best-effort: GC removes what is left
}

type layerInfo struct {
	org    string // org dir
	digest string
	bytes  int64
	used   time.Time
}

func (s *Store) layersOf(od string) []layerInfo {
	des, _ := os.ReadDir(filepath.Join(od, "layers"))
	var out []layerInfo
	for _, d := range des {
		if !hexRe.MatchString(d.Name()) {
			continue
		}
		lp := filepath.Join(od, "layers", d.Name())
		l, err := readLayer(lp)
		if err != nil {
			continue
		}
		used := l.BuiltAt
		if fi, err := os.Stat(filepath.Join(lp, "used")); err == nil {
			used = fi.ModTime()
		}
		out = append(out, layerInfo{org: od, digest: d.Name(), bytes: l.Bytes, used: used})
	}
	return out
}

// evictToFit makes room for a layer of n bytes in the org and in the cell by
// removing the least recently mounted layers that no sandbox holds. If it
// cannot, nothing more is removed and the new layer is refused.
func (s *Store) evictToFit(org string, n int64) error {
	od := s.OrgDir(org)
	for {
		mine := s.layersOf(od)
		var orgBytes int64
		for _, l := range mine {
			orgBytes += l.bytes
		}
		orgOver := orgBytes+n > s.cfg.MaxOrgBytes || len(mine)+1 > s.cfg.MaxOrgLayers
		pool := mine
		cellOver := false
		if !orgOver {
			var all []layerInfo
			var cellBytes int64
			for _, o := range s.orgDirs() {
				for _, l := range s.layersOf(o) {
					all = append(all, l)
					cellBytes += l.bytes
				}
			}
			if cellBytes+n > s.cfg.MaxCellBytes {
				cellOver, pool = true, all
			}
		}
		if !orgOver && !cellOver {
			return nil
		}
		var victim *layerInfo
		for i := range pool {
			l := &pool[i]
			if s.holds[s.holdKey(l.org, l.digest)] > 0 {
				continue
			}
			if victim == nil || l.used.Before(victim.used) {
				victim = l
			}
		}
		if victim == nil {
			if orgOver {
				return refused("org_full", "every layer of the org is mounted")
			}
			return refused("cell_full", "every layer of the cell is mounted")
		}
		s.evictLocked(victim.org, victim.digest, nil)
	}
}

// PurgeOrg removes everything stored for the org.
func (s *Store) PurgeOrg(org string) error {
	if org == "" {
		return errors.New("toollayer: no org")
	}
	od := s.OrgDir(org)
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.verified {
		if strings.HasPrefix(k, od+"/") {
			delete(s.verified, k)
		}
	}
	return removeTree(od)
}

// removeTree deletes a directory of read-only trees (0555 directories cannot
// be emptied) without following a link.
func removeTree(p string) error {
	_ = filepath.WalkDir(p, func(q string, d fs.DirEntry, err error) error { //nolint:gosec // G703: p is a store-owned directory (staging, a layer, an org dir); WalkDir does not follow links
		if err == nil && d.IsDir() {
			_ = os.Chmod(q, 0o700) //nolint:gosec // G302: a directory, which needs its search bit
		}
		return nil
	})
	//nolint:gosec // G703: p is a store-owned directory (staging, a layer, an org dir), never request data
	if err := os.RemoveAll(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
