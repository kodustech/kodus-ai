package toollayer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// fullRehashEvery is U8's period: the fingerprint is the hot path, the full
// sha256 of the tree runs at the first mount after a start (the verified map
// is empty), every 24 h per layer, and whenever the fingerprint differs.
const fullRehashEvery = 24 * time.Hour

// corruptError means the tree on disk is not the layer that was stored.
type corruptError struct {
	why      string
	badFiles []string // names in files/ whose shared inode changed
}

func (e *corruptError) Error() string { return "toollayer: corrupt layer: " + e.why }

// verify answers whether the tree about to be mounted is the layer that was
// built. A fingerprint difference is not yet corruption: linking a file into
// another layer changes its ctime, so a difference only triggers the rehash,
// and the rehash decides (and refreshes the fingerprints when it agrees).
func (s *Store) verify(ctx context.Context, od, digest string) (Layer, error) {
	layerPath := filepath.Join(od, "layers", digest)
	tree := filepath.Join(layerPath, "tree")
	for _, d := range []string{od, filepath.Join(od, "layers"), layerPath, tree} {
		if err := realDir(d); err != nil {
			return Layer{}, &corruptError{why: err.Error()}
		}
	}
	layer, err := readLayer(layerPath)
	if err != nil || layer.Digest != digest {
		return Layer{}, &corruptError{why: "layer.json unreadable or for another digest"}
	}

	vk := s.holdKey(od, digest)
	now := s.cfg.Now()
	s.mu.Lock()
	last, seen := s.verified[vk]
	s.mu.Unlock()
	full := !seen || now.Sub(last) >= fullRehashEvery
	if !full {
		obs, err := scanTree(ctx, tree, false)
		if cerr := ctx.Err(); cerr != nil {
			return Layer{}, cerr
		}
		full = err != nil || !sameManifest(layer.Entries, obs)
	}
	if !full {
		return layer, nil
	}

	obs, err := scanTree(ctx, tree, true)
	if cerr := ctx.Err(); cerr != nil {
		return Layer{}, cerr
	}
	if err != nil {
		return Layer{}, &corruptError{why: err.Error()}
	}
	if layerDigest(obs) != digest {
		return Layer{}, &corruptError{why: "tree digest differs", badFiles: s.changedShared(od, tree, layer.Entries, obs)}
	}
	if !sameManifest(layer.Entries, obs) {
		for i := range layer.Entries {
			layer.Entries[i].FP = nil
		}
		fps := map[string]*Fingerprint{}
		for i := range obs {
			fps[obs[i].Path] = obs[i].FP
		}
		for i := range layer.Entries {
			layer.Entries[i].FP = fps[layer.Entries[i].Path]
		}
		s.mu.Lock()
		err := s.writeLayerJSON(layerPath, layer)
		s.mu.Unlock()
		if err != nil {
			return Layer{}, err
		}
	}
	s.mu.Lock()
	s.verified[vk] = now
	s.mu.Unlock()
	return layer, nil
}

// changedShared names the org-store files whose inode is the one a changed
// tree file is linked to: they are tampered too, and must not be linked again.
func (s *Store) changedShared(od, tree string, want, got []Entry) []string {
	have := map[string]string{}
	for _, e := range got {
		if e.Type == "file" {
			have[e.Path] = e.SHA256
		}
	}
	var bad []string
	for _, e := range want {
		if e.Type != "file" || have[e.Path] == e.SHA256 {
			continue
		}
		// The manifest is read from disk: only a local path and a sha256 hex
		// may reach the Lstat calls below, so a tampered one cannot probe
		// outside the tree or the files/ directory.
		if !filepath.IsLocal(filepath.FromSlash(e.Path)) || !hexRe.MatchString(e.SHA256) {
			continue
		}
		a, errA := os.Lstat(filepath.Join(tree, filepath.FromSlash(e.Path))) //nolint:gosec // G703: e.Path passed filepath.IsLocal above; Lstat only inspects
		b, errB := os.Lstat(filepath.Join(od, "files", e.SHA256))
		if errA == nil && errB == nil && os.SameFile(a, b) {
			bad = append(bad, e.SHA256)
		}
	}
	return bad
}

// scanTree lists the tree as it is on disk, sorted by path; with hash it
// reads every file. It never follows a link.
func scanTree(ctx context.Context, tree string, hash bool) ([]Entry, error) {
	var out []Entry
	err := filepath.WalkDir(tree, func(p string, d fs.DirEntry, err error) error { //nolint:gosec // G703: tree is the layer tree the store built from a verified digest; WalkDir does not follow links
		if err != nil {
			return err
		}
		if p == tree {
			return nil
		}
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(tree, p)
		if err != nil {
			return err
		}
		e := Entry{Path: filepath.ToSlash(rel), Mode: uint32(info.Mode().Perm())}
		switch m := info.Mode(); {
		case m.IsDir():
			e.Type = "dir"
		case m.IsRegular():
			e.Type, e.Size = "file", info.Size()
			fp := fingerprintOf(info)
			e.FP = &fp
			if hash {
				if e.SHA256, err = hashFile(p); err != nil {
					return err
				}
			}
		case m&fs.ModeSymlink != 0:
			// A link has no mode of its own (the umask shows through on some systems).
			e.Type, e.Mode = "symlink", modeLink
			if e.Target, err = os.Readlink(p); err != nil {
				return err
			}
		default:
			e.Type = "other"
		}
		out = append(out, e)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func hashFile(p string) (string, error) {
	f, err := os.Open(p) //nolint:gosec // G304: p is a file WalkDir found under the layer tree (the only caller)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }() // read-only: a close error loses nothing
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// sameManifest is the fast check: structure, modes, sizes, link targets and
// the stat fingerprint of every file. It does not read any content.
func sameManifest(want, got []Entry) bool {
	if len(want) != len(got) {
		return false
	}
	w := make([]Entry, len(want))
	copy(w, want)
	sort.Slice(w, func(i, j int) bool { return w[i].Path < w[j].Path })
	for i := range w {
		a, b := w[i], got[i]
		if a.Path != b.Path || a.Type != b.Type || a.Mode != b.Mode || a.Size != b.Size || a.Target != b.Target {
			return false
		}
		if a.Type == "file" && (a.FP == nil || b.FP == nil || *a.FP != *b.FP) {
			return false
		}
	}
	return true
}
