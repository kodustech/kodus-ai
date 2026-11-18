package vmsnap

import (
	"archive/tar"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// A template moves to another host (a per-Run instance fed from object
// storage, the Firecracker spike's round 3) as one archive that Export
// writes and Import reads. Copied by hand it was refused: GNU tar's
// default format keeps whole seconds, and Open refuses a file whose time is
// not the ModUnixNano it was published with ("rootfs.ext4 changed since it
// was published"). A copy may also lose a disk's holes, and the digest
// names a file as laid out (digestFile).
//
// The archive is a PAX tar: manifest.json, then for each file of the
// snapshot's shape "<file>.runs" (its runs of data, JSON) and "<file>"
// (those runs' bytes, back to back), with its time to the nanosecond. Import
// lays every run at its offset, so holes stay holes, checks each file
// against the manifest's digest, then stamps it with the manifest's time
// whatever the archive said, and publishes the manifest last. A template
// keeps its id, so the hub's image ids stay valid on the new host.

const (
	runsSuffix = ".runs"
	// maxManifestBytes and maxRunsBytes bound what Import reads into memory.
	maxManifestBytes = 1 << 20
	maxRunsBytes     = 64 << 20
)

// Export writes org's template id to w: checked first as a restore checks
// it (Open), so only what the store would restore leaves it. A round or a
// session never leaves its host.
func (s *Store) Export(org, id string, w io.Writer) error {
	m, dir, err := s.Open(org, id)
	if err != nil {
		return err
	}
	if m.Purpose != isolation.PurposeTemplate {
		return refuse("snapshot %s is a %s; only a template is exported", id, m.Purpose)
	}
	raw, err := os.ReadFile(filepath.Join(dir, manifestName)) //nolint:gosec // G304: the store's own directory, the id checked
	if err != nil {
		return err
	}
	tw := tar.NewWriter(w)
	if err := writeEntry(tw, manifestName, 0o400, m.Created, raw); err != nil {
		return err
	}
	for _, name := range filesOf(m.Shape) {
		if err := exportFile(tw, filepath.Join(dir, name), name, m.Files[name]); err != nil {
			return fmt.Errorf("vmsnap: export %s of %s: %w", name, id, err)
		}
	}
	return tw.Close()
}

func writeEntry(tw *tar.Writer, name string, mode int64, mod time.Time, body []byte) error {
	if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: mode, Size: int64(len(body)), ModTime: mod, Format: tar.FormatPAX}); err != nil {
		return err
	}
	_, err := tw.Write(body)
	return err
}

func exportFile(tw *tar.Writer, p, name string, want File) error {
	f, err := os.Open(p) //nolint:gosec // G304: a file of the store's own directory
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	runs, size, err := dataRuns(f)
	if err != nil {
		return err
	}
	if size != want.Size {
		return refuse("%s holds %d bytes, its manifest %d", name, size, want.Size)
	}
	raw, err := json.Marshal(runs)
	if err != nil {
		return err
	}
	mod := time.Unix(0, want.ModUnixNano)
	if err := writeEntry(tw, name+runsSuffix, 0o400, mod, raw); err != nil {
		return err
	}
	var n int64
	for _, r := range runs {
		n += r.Length
	}
	if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: int64(fileMode(name)), Size: n, ModTime: mod, Format: tar.FormatPAX}); err != nil {
		return err
	}
	for _, r := range runs {
		if _, err := io.Copy(tw, io.NewSectionReader(f, r.Offset, r.Length)); err != nil {
			return err
		}
	}
	return nil
}

// fileMode is a published file's mode: the memory file is read by the
// VMMs' users through a hard link; the rest is the cell's alone.
func fileMode(name string) os.FileMode {
	if name == FileMem {
		return 0o444
	}
	return 0o400
}

// Import reads an archive Export wrote into org's store and publishes it.
// It refuses anything but a template of org of the shape's exact files, an
// id the store holds already, a run out of its file, and a file whose
// digest is not its manifest's; what it wrote of a refused one is removed.
// Every file gets its manifest's time to the nanosecond, so a later Open
// finds it as it was published.
func (s *Store) Import(org string, r io.Reader) (Manifest, error) {
	tr := tar.NewReader(r)
	raw, err := readEntry(tr, manifestName, maxManifestBytes)
	if err != nil {
		return Manifest{}, err
	}
	m, err := decodeManifest(raw)
	if err != nil {
		return Manifest{}, err
	}
	if err := m.Check(org, m.ID); err != nil {
		return Manifest{}, err
	}
	if m.Purpose != isolation.PurposeTemplate {
		return Manifest{}, refuse("snapshot %s is a %s; only a template is imported", m.ID, m.Purpose)
	}
	dir, err := s.snapDir(org, m.ID)
	if err != nil {
		return Manifest{}, err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return Manifest{}, err
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			return Manifest{}, refuse("org %q holds snapshot %s already", org, m.ID)
		}
		return Manifest{}, err
	}
	done := false
	defer func() {
		if !done {
			_ = os.RemoveAll(dir)
		}
	}()
	for _, name := range filesOf(m.Shape) {
		if err := s.importFile(tr, filepath.Join(dir, name), name, m.Files[name]); err != nil {
			return Manifest{}, fmt.Errorf("vmsnap: import %s of %s: %w", name, m.ID, err)
		}
	}
	if _, err := tr.Next(); !errors.Is(err, io.EOF) {
		return Manifest{}, errors.Join(err, refuse("snapshot %s: the archive holds more than its files", m.ID))
	}
	if err := writeSynced(filepath.Join(dir, manifestName+".tmp"), raw); err != nil {
		return Manifest{}, err
	}
	if err := os.Rename(filepath.Join(dir, manifestName+".tmp"), filepath.Join(dir, manifestName)); err != nil {
		return Manifest{}, err
	}
	if err := syncDir(dir); err != nil {
		return Manifest{}, err
	}
	done = true
	s.mu.Lock()
	s.verified[m.ID] = memKey(m)
	s.mu.Unlock()
	return m, nil
}

// readEntry is the archive's next entry, which must be a regular file of
// that name and at most limit bytes.
func readEntry(tr *tar.Reader, name string, limit int64) ([]byte, error) {
	h, err := tr.Next()
	if err != nil {
		return nil, refuse("the archive ends before %s: %v", name, err)
	}
	if h.Name != name || h.Typeflag != tar.TypeReg {
		return nil, refuse("the archive holds %q where %s goes", h.Name, name)
	}
	if h.Size > limit {
		return nil, refuse("%s is %d bytes, over %d", name, h.Size, limit)
	}
	return io.ReadAll(tr)
}

func (s *Store) importFile(tr *tar.Reader, p, name string, want File) error {
	raw, err := readEntry(tr, name+runsSuffix, maxRunsBytes)
	if err != nil {
		return err
	}
	var runs []Run
	if err := json.Unmarshal(raw, &runs); err != nil {
		return refuse("%s%s: %v", name, runsSuffix, err)
	}
	var n, end int64
	for _, r := range runs {
		if r.Offset < end || r.Length <= 0 || r.Offset > want.Size-r.Length {
			return refuse("%s: run %+v is out of order or of its %d-byte file", name, r, want.Size)
		}
		n, end = n+r.Length, r.Offset+r.Length
	}
	h, err := tr.Next()
	if err != nil {
		return refuse("the archive ends before %s: %v", name, err)
	}
	if h.Name != name || h.Typeflag != tar.TypeReg || h.Size != n {
		return refuse("the archive holds %q (%d bytes) where %s's %d bytes of data go", h.Name, h.Size, name, n)
	}
	if s.Free != nil {
		free, err := s.Free()
		if err != nil {
			return err
		}
		if free < n+freeMargin {
			return refuse("the store's file system has %d bytes free; %s needs %d and %d more kept free", free, name, n, freeMargin)
		}
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) //nolint:gosec // G304: a new file of the store's own directory
	if err != nil {
		return err
	}
	err = layRuns(f, tr, runs, want.Size)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if err := s.Chown(p, 0, 0); err != nil {
		return err
	}
	if err := os.Chmod(p, fileMode(name)); err != nil {
		return err
	}
	sum, size, err := digestAndSync(p)
	if err != nil {
		return err
	}
	if size != want.Size || sum != want.SHA256 {
		return refuse("%s is not the one exported (its digest or size differs)", name)
	}
	mod := time.Unix(0, want.ModUnixNano)
	if err := os.Chtimes(p, mod, mod); err != nil {
		return err
	}
	fi, err := os.Stat(p)
	if err != nil {
		return err
	}
	if fi.ModTime().UnixNano() != want.ModUnixNano {
		return refuse("%s: this file system keeps %v for %v; the store needs times to the nanosecond", name, fi.ModTime(), mod)
	}
	return nil
}

// layRuns writes each run's bytes at its offset and sizes f, so the gaps
// between runs are holes as they were on the exporting host.
func layRuns(f *os.File, r io.Reader, runs []Run, size int64) error {
	for _, run := range runs {
		n, err := io.Copy(io.NewOffsetWriter(f, run.Offset), io.LimitReader(r, run.Length))
		if err != nil {
			return err
		}
		if n != run.Length {
			return refuse("a run at %d holds %d of its %d bytes", run.Offset, n, run.Length)
		}
	}
	if err := f.Truncate(size); err != nil {
		return err
	}
	return f.Sync()
}
