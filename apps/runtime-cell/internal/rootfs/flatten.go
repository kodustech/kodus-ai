// Package rootfs turns an OCI image into a microVM's root file system
// (docs/runtime/isolation-architecture.md C3, firecracker): the image's
// layers flattened as the OCI spec applies them (whiteouts, opaque
// directories), the guest agent added as the machine's init with its
// profile (internal/guestinit), and an ext4 image made from the result.
//
// Flattening is tar to tar: ownership and modes travel in the headers, so
// nothing needs root, and the ext4 step (mkfs.ext4 -d, e2fsprogs 1.47.1 or
// later) reads the same tar. That step runs where the microVM kit is built,
// never inside the cell.
package rootfs

import (
	"archive/tar"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
)

// GuestPath is where the guest agent lives in every rootfs, relative to
// its root (guestinit.AgentPath): the kernel starts it as init.
var GuestPath = strings.TrimPrefix(guestinit.AgentPath, "/")

// Layer opens one layer's uncompressed tar stream; it may be called twice.
type Layer func() (io.ReadCloser, error)

// Options say what the rootfs is for.
type Options struct {
	Profile guestinit.Profile
	// Guest is the guest agent's binary (cmd/kody-guest for the target arch).
	Guest []byte
	// ModTime stamps what the builder adds (reproducible builds: the
	// source date). Zero: the Unix epoch.
	ModTime time.Time
}

const (
	whiteoutPrefix = ".wh."
	opaqueMarker   = ".wh..wh..opq"
)

// entry is the winning header for a path: the layer and the position in it
// that wrote it, so the second pass streams its data.
type entry struct {
	hdr   *tar.Header
	layer int
	pos   int
	// added is an entry the builder adds, with its data.
	added []byte
}

// clean is a layer path relative to the root, "" for the root itself; a
// path that climbs out of it is refused.
func clean(name string) (string, error) {
	p := path.Clean("/" + strings.TrimPrefix(name, "./"))
	if strings.Contains(name, "..") {
		for _, seg := range strings.Split(name, "/") {
			if seg == ".." {
				return "", fmt.Errorf("rootfs: %q climbs out of the root", name)
			}
		}
	}
	return strings.TrimPrefix(p, "/"), nil
}

func under(p, dir string) bool { return dir == "" || strings.HasPrefix(p, dir+"/") }

type tree struct {
	m map[string]*entry
}

// removeUnder drops everything below dir written by a layer before layer.
func (t *tree) removeUnder(dir string, layer int) {
	for p, e := range t.m {
		if under(p, dir) && p != dir && e.layer < layer {
			delete(t.m, p)
		}
	}
}

func (t *tree) removeTree(p string) {
	delete(t.m, p)
	t.removeUnder(p, 1<<30)
}

// Flatten writes the image's file system as one tar to w: layers applied
// in order with their whiteouts, then the builder's own entries.
func Flatten(layers []Layer, w io.Writer, opt Options) error {
	if len(opt.Guest) == 0 {
		return errors.New("rootfs: no guest agent binary")
	}
	if _, err := guestinit.ProfileByName(opt.Profile.Name); err != nil {
		return err
	}
	t := &tree{m: map[string]*entry{}}
	for i, open := range layers {
		if err := t.apply(i, open); err != nil {
			return fmt.Errorf("rootfs: layer %d: %w", i, err)
		}
	}
	if err := t.addOwn(opt); err != nil {
		return err
	}
	if err := t.fill(opt.ModTime); err != nil {
		return err
	}
	sandbox := opt.Profile.Name == guestinit.Sandbox
	for p, e := range t.m {
		h := e.hdr
		if sandbox {
			// No way to become root in a sandbox: no set-id file, no
			// device node (the guest's /dev is the kernel's devtmpfs) and
			// no FIFO.
			if h.Typeflag == tar.TypeChar || h.Typeflag == tar.TypeBlock || h.Typeflag == tar.TypeFifo {
				delete(t.m, p)
				continue
			}
			h.Mode &^= 0o6000
		}
	}
	return t.write(layers, w)
}

func (t *tree) apply(layer int, open Layer) error {
	rc, err := open()
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()
	tr := tar.NewReader(rc)
	for pos := 0; ; pos++ {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			// Read to the end, so a layer checked against its digest is
			// checked whole.
			_, err = io.Copy(io.Discard, rc)
			return err
		}
		if err != nil {
			return err
		}
		p, err := clean(h.Name)
		if err != nil {
			return err
		}
		dir, base := path.Split(p)
		dir = strings.TrimSuffix(dir, "/")
		switch {
		case base == opaqueMarker:
			t.removeUnder(dir, layer)
			continue
		case strings.HasPrefix(base, whiteoutPrefix):
			t.removeTree(path.Join(dir, strings.TrimPrefix(base, whiteoutPrefix)))
			continue
		case p == "":
			continue // the root's own entry: the builder writes it
		}
		switch h.Typeflag {
		case tar.TypeReg, tar.TypeDir, tar.TypeSymlink, tar.TypeLink, tar.TypeChar, tar.TypeBlock, tar.TypeFifo:
		default:
			continue // PAX globals and the like carry no file
		}
		if h.Typeflag == tar.TypeLink {
			if h.Linkname, err = clean(h.Linkname); err != nil {
				return err
			}
		}
		if old, ok := t.m[p]; ok && old.hdr.Typeflag == tar.TypeDir && h.Typeflag != tar.TypeDir {
			t.removeTree(p) // a file over a directory hides what was in it
		}
		hc := *h
		hc.Name = p
		t.m[p] = &entry{hdr: &hc, layer: layer, pos: pos}
	}
}

// addOwn puts the guest agent, its profile, the resolver link and the
// mount points in, over whatever the image had at those paths.
func (t *tree) addOwn(opt Options) error {
	profile, err := json.Marshal(opt.Profile)
	if err != nil {
		return err
	}
	mt := opt.ModTime
	if mt.IsZero() {
		mt = time.Unix(0, 0)
	}
	file := func(p string, mode int64, data []byte) {
		t.removeTree(p)
		t.m[p] = &entry{hdr: &tar.Header{Typeflag: tar.TypeReg, Name: p, Mode: mode, Size: int64(len(data)), ModTime: mt}, layer: -1, added: data}
	}
	dir := func(p string, mode int64) {
		if e, ok := t.m[p]; ok && e.hdr.Typeflag == tar.TypeDir {
			return // the image's own directory, with its owner and mode
		}
		t.removeTree(p)
		t.m[p] = &entry{hdr: &tar.Header{Typeflag: tar.TypeDir, Name: p, Mode: mode, ModTime: mt}, layer: -1}
	}
	file(GuestPath, 0o755, opt.Guest)
	file(strings.TrimPrefix(guestinit.ProfilePath, "/"), 0o644, profile)
	t.removeTree("etc/resolv.conf")
	t.m["etc/resolv.conf"] = &entry{hdr: &tar.Header{Typeflag: tar.TypeSymlink, Name: "etc/resolv.conf", Linkname: guestinit.ResolvPath, Mode: 0o777, ModTime: mt}, layer: -1}
	for _, d := range []string{"proc", "sys", "dev", "run", "workspace"} {
		dir(d, 0o755)
	}
	dir("tmp", 0o1777)
	if opt.Profile.DataDevice != "" {
		dir(strings.TrimPrefix(guestinit.DataMount, "/"), 0o711)
		dir("var/lib/containerd", 0o711)
	}
	return nil
}

// fill adds the directories a path needs that no layer wrote, and refuses
// a path below something that is not a directory.
func (t *tree) fill(mt time.Time) error {
	if mt.IsZero() {
		mt = time.Unix(0, 0)
	}
	paths := make([]string, 0, len(t.m))
	for p := range t.m {
		paths = append(paths, p)
	}
	for _, p := range paths {
		for d := path.Dir(p); d != "." && d != "/"; d = path.Dir(d) {
			if e, ok := t.m[d]; ok {
				if e.hdr.Typeflag != tar.TypeDir {
					return fmt.Errorf("rootfs: %s is below %s, which is not a directory", p, d)
				}
				continue
			}
			t.m[d] = &entry{hdr: &tar.Header{Typeflag: tar.TypeDir, Name: d, Mode: 0o755, ModTime: mt}, layer: -1}
		}
	}
	return nil
}

// write emits the root, every directory (parents first), then each layer's
// winning entries with their data, the builder's files, and the hard links
// last, once what they point at is written.
func (t *tree) write(layers []Layer, w io.Writer) error {
	tw := tar.NewWriter(w)
	paths := make([]string, 0, len(t.m))
	for p, e := range t.m {
		if e.hdr.Typeflag == tar.TypeDir {
			paths = append(paths, p)
		}
	}
	slices.Sort(paths)
	put := func(h *tar.Header) error {
		out := *h
		out.Uname, out.Gname = "", ""
		out.Format = tar.FormatPAX
		out.AccessTime, out.ChangeTime = time.Time{}, time.Time{}
		if out.Typeflag == tar.TypeDir && !strings.HasSuffix(out.Name, "/") {
			out.Name += "/"
		}
		return tw.WriteHeader(&out)
	}
	if err := put(&tar.Header{Typeflag: tar.TypeDir, Name: "./", Mode: 0o755, ModTime: time.Unix(0, 0)}); err != nil {
		return err
	}
	for _, p := range paths {
		e := t.m[p]
		d := e.hdr
		dc := *d
		dc.Name = "./" + p
		if err := put(&dc); err != nil {
			return err
		}
	}
	var links []*tar.Header
	for i, open := range layers {
		if err := t.stream(i, open, tw, put, &links); err != nil {
			return fmt.Errorf("rootfs: layer %d: %w", i, err)
		}
	}
	added := make([]string, 0)
	for p, e := range t.m {
		if e.layer == -1 && e.hdr.Typeflag != tar.TypeDir {
			added = append(added, p)
		}
	}
	slices.Sort(added)
	for _, p := range added {
		e := t.m[p]
		h := *e.hdr
		h.Name = "./" + p
		if err := put(&h); err != nil {
			return err
		}
		if _, err := tw.Write(e.added); err != nil {
			return err
		}
	}
	for _, h := range links {
		target, ok := t.m[h.Linkname]
		if !ok || target.hdr.Typeflag != tar.TypeReg {
			return fmt.Errorf("rootfs: hard link %s points at %s, which is not a file of the image", h.Name, h.Linkname)
		}
		hc := *h
		hc.Name, hc.Linkname = "./"+h.Name, "./"+h.Linkname
		if err := put(&hc); err != nil {
			return err
		}
	}
	return tw.Close()
}

func (t *tree) stream(layer int, open Layer, tw *tar.Writer, put func(*tar.Header) error, links *[]*tar.Header) error {
	rc, err := open()
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()
	tr := tar.NewReader(rc)
	for pos := 0; ; pos++ {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			// Read to the end, so a layer checked against its digest is
			// checked whole.
			_, err = io.Copy(io.Discard, rc)
			return err
		}
		if err != nil {
			return err
		}
		p, err := clean(h.Name)
		if err != nil {
			return err
		}
		e, ok := t.m[p]
		if !ok || e.layer != layer || e.pos != pos || e.hdr.Typeflag == tar.TypeDir {
			continue
		}
		if e.hdr.Typeflag == tar.TypeLink {
			*links = append(*links, e.hdr)
			continue
		}
		hc := *e.hdr
		hc.Name = "./" + p
		if err := put(&hc); err != nil {
			return err
		}
		if hc.Typeflag == tar.TypeReg {
			if _, err := io.Copy(tw, tr); err != nil { //nolint:gosec // G110: the size is the header's, written as read
				return err
			}
		}
	}
}
