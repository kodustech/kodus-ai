package mirror

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
)

// A BlobStore keeps content-addressed bytes (layers and manifests, by their
// sha256 digest) for the OCI mirror. What a digest names never changes, and
// the mirror serves only public Docker Hub content, so one stored copy is
// shared by every claim and tenant of the cell; who may read it is still
// decided per request by ImagePins, before the store is asked.
type BlobStore interface {
	// Open returns the stored bytes of digest, or ErrNotCached.
	Open(digest string) (Blob, error)
	// Create starts writing digest. Nothing is visible to Open until
	// Commit has checked the bytes against the digest.
	Create(digest string) (BlobWriter, error)
}

// Blob is one stored digest, open for reading.
type Blob interface {
	io.ReadSeekCloser
	Size() int64
}

// BlobWriter receives the bytes of one digest.
type BlobWriter interface {
	io.Writer
	// Commit checks the bytes against the digest and makes them durable and
	// visible; on a mismatch nothing is kept and ErrDigestMismatch returns.
	Commit() error
	// Abort drops what was written. Safe after Commit.
	Abort()
}

var (
	ErrNotCached      = errors.New("mirror: not cached")
	ErrDigestMismatch = errors.New("mirror: the bytes are not their digest")
)

var hex64 = regexp.MustCompile(`^[a-f0-9]{64}$`)

// DiskStore is a BlobStore in a directory, bounded by size with LRU
// eviction:
//
//	<dir>/sha256/<hex>  committed bytes, named by their digest
//	<dir>/tmp/          writes in progress
//
// A write goes to tmp, is hashed while written, fsynced, and renamed into
// sha256/ only when the hash is the digest, so a crash or a bad upstream
// leaves at most a temp file, which OpenDiskStore removes; a file under
// sha256/ is always whole and correct. Use order lives in memory and in
// the files' mtime (touched on each hit), so it survives a restart.
type DiskStore struct {
	dir, tmp string
	max      int64
	clock    clock.Clock
	metrics  *CacheMetrics

	mu    sync.Mutex
	lru   *list.List // of *diskEntry, most recently used first
	index map[string]*list.Element
	size  int64
}

type diskEntry struct {
	hex  string
	size int64
}

// OpenDiskStore opens (or creates) the store in dir, holding at most
// maxBytes. Leftover temp files of an earlier run are removed, and so is
// anything under sha256/ that is not named by a digest.
func OpenDiskStore(dir string, maxBytes int64, c clock.Clock, m *CacheMetrics) (*DiskStore, error) {
	if maxBytes <= 0 {
		return nil, errors.New("mirror: the cache needs a positive size")
	}
	s := &DiskStore{dir: filepath.Join(dir, "sha256"), tmp: filepath.Join(dir, "tmp"), max: maxBytes,
		clock: clock.Or(c), metrics: m, lru: list.New(), index: map[string]*list.Element{}}
	if err := os.RemoveAll(s.tmp); err != nil {
		return nil, fmt.Errorf("mirror: clean the cache's temp files: %w", err)
	}
	for _, d := range []string{s.dir, s.tmp} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, fmt.Errorf("mirror: cache directory: %w", err)
		}
	}
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, fmt.Errorf("mirror: read the cache: %w", err)
	}
	type found struct {
		diskEntry
		used int64
	}
	var all []found
	for _, e := range ents {
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() || !hex64.MatchString(e.Name()) {
			_ = os.RemoveAll(filepath.Join(s.dir, e.Name()))
			continue
		}
		all = append(all, found{diskEntry{e.Name(), info.Size()}, info.ModTime().UnixNano()})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].used > all[j].used })
	for _, f := range all {
		s.index[f.hex] = s.lru.PushBack(&diskEntry{f.hex, f.size})
		s.size += f.size
	}
	s.mu.Lock()
	s.evictLocked(nil)
	s.mu.Unlock()
	return s, nil
}

func digestHex(digest string) (string, error) {
	if !IsDigest(digest) {
		return "", fmt.Errorf("mirror: %q is not a sha256 digest", digest)
	}
	return strings.TrimPrefix(digest, "sha256:"), nil
}

func (s *DiskStore) Open(digest string) (Blob, error) {
	h, err := digestHex(digest)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	el, ok := s.index[h]
	if !ok {
		return nil, ErrNotCached
	}
	f, err := os.Open(filepath.Join(s.dir, h))
	if err != nil {
		// Removed behind our back: forget it, the next request refetches.
		s.removeLocked(el)
		return nil, ErrNotCached
	}
	s.lru.MoveToFront(el)
	now := s.clock.Now()
	_ = os.Chtimes(f.Name(), now, now) // best effort: only the order after a restart depends on it
	return &diskBlob{File: f, size: el.Value.(*diskEntry).size}, nil
}

func (s *DiskStore) Create(digest string) (BlobWriter, error) {
	h, err := digestHex(digest)
	if err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(s.tmp, h+".*")
	if err != nil {
		return nil, fmt.Errorf("mirror: cache temp file: %w", err)
	}
	return &diskWriter{s: s, f: f, hex: h, sum: sha256.New()}, nil
}

// Bytes is what the store holds now (tests, the size gauge).
func (s *DiskStore) Bytes() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.size
}

func (s *DiskStore) add(h string, size int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if el, ok := s.index[h]; ok {
		// Two writers committed the same digest: the rename replaced
		// identical bytes, the accounting stays as it was.
		s.lru.MoveToFront(el)
		return
	}
	el := s.lru.PushFront(&diskEntry{h, size})
	s.index[h] = el
	s.size += size
	s.evictLocked(el)
}

// evictLocked removes the least recently used blobs until the store fits,
// never keep (the blob just committed, which its waiters are about to
// open), so one blob larger than the bound still gets served once. A
// reader that has an evicted file open keeps reading it: unlinking does
// not take the inode from an open descriptor.
func (s *DiskStore) evictLocked(keep *list.Element) {
	for s.size > s.max {
		el := s.lru.Back()
		if el == nil || el == keep {
			break
		}
		_ = os.Remove(filepath.Join(s.dir, el.Value.(*diskEntry).hex))
		s.removeLocked(el)
		s.metrics.evicted()
	}
	s.metrics.setBytes(s.size)
}

func (s *DiskStore) removeLocked(el *list.Element) {
	e := el.Value.(*diskEntry)
	s.lru.Remove(el)
	delete(s.index, e.hex)
	s.size -= e.size
}

type diskBlob struct {
	*os.File
	size int64
}

func (b *diskBlob) Size() int64 { return b.size }

type diskWriter struct {
	s    *DiskStore
	f    *os.File
	hex  string
	sum  hash.Hash
	n    int64
	done bool
}

func (w *diskWriter) Write(p []byte) (int, error) {
	n, err := w.f.Write(p)
	w.sum.Write(p[:n])
	w.n += int64(n)
	return n, err
}

func (w *diskWriter) Commit() error {
	if w.done {
		return errors.New("mirror: blob writer already closed")
	}
	// The check that keeps a wrong blob out of the cache for every claim
	// after this one: the name under sha256/ is a promise about the bytes.
	if hex.EncodeToString(w.sum.Sum(nil)) != w.hex {
		w.Abort()
		return ErrDigestMismatch
	}
	w.done = true
	tmp := w.f.Name()
	err := w.f.Sync()
	if cerr := w.f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, filepath.Join(w.s.dir, w.hex))
	}
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("mirror: commit to the cache: %w", err)
	}
	// The rename is durable only once the directory is synced.
	if d, err := os.Open(w.s.dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	w.s.add(w.hex, w.n)
	return nil
}

func (w *diskWriter) Abort() {
	if w.done {
		return
	}
	w.done = true
	_ = w.f.Close()
	_ = os.Remove(w.f.Name())
}
