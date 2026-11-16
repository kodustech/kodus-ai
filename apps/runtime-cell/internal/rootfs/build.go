package rootfs

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// TarLayer is a single tar of a whole file system (a flattened export) as a
// one-layer image.
func TarLayer(path string) Layer {
	return func() (io.ReadCloser, error) {
		f, err := os.Open(path) //nolint:gosec // G304: the operator's export
		if err != nil {
			return nil, fmt.Errorf("rootfs: %w", err)
		}
		return f, nil
	}
}

// Build makes the ext4 image out from layers: Flatten into a tar in scratch
// (a directory the caller owns), then MakeExt4.
func Build(ctx context.Context, layers []Layer, opt Options, fs Ext4, scratch, out string) error {
	tmp := filepath.Join(scratch, "rootfs.tar")
	f, err := os.Create(tmp) //nolint:gosec // G304: the caller's scratch directory
	if err != nil {
		return err
	}
	err = Flatten(layers, f, opt)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	defer func() { _ = os.Remove(tmp) }()
	if err != nil {
		return err
	}
	return MakeExt4(ctx, tmp, out, fs)
}

// List reads a Flatten output: each path with its header. For tests and for
// the builder's own summary.
func List(r io.Reader) (map[string]*tar.Header, map[string][]byte, error) {
	hdrs, data := map[string]*tar.Header{}, map[string][]byte{}
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return hdrs, data, nil
		}
		if err != nil {
			return nil, nil, err
		}
		p, err := clean(h.Name)
		if err != nil {
			return nil, nil, err
		}
		if _, dup := hdrs[p]; dup && p != "" {
			return nil, nil, fmt.Errorf("rootfs: %s written twice", p)
		}
		hdrs[p] = h
		if h.Typeflag == tar.TypeReg {
			b, err := io.ReadAll(io.LimitReader(tr, 64<<20))
			if err != nil {
				return nil, nil, err
			}
			data[p] = b
		}
	}
}
