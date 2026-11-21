// Package checkoutfs writes the cell's own files into a checkout. The
// checkout is the PR's code: any name in it may already be a symlink the PR
// planted (to /etc/..., to the cell's state), so a plain os.WriteFile there
// is a write wherever the PR points.
package checkoutfs

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// Replace writes data to name inside checkout as a new regular file: what
// the checkout had under that name (file, directory link or symlink) is
// removed first, the file is created exclusively, and every path step is
// resolved inside the checkout (os.Root), so nothing outside it is touched.
func Replace(checkout, name string, data []byte, perm fs.FileMode) error {
	if name == "" || filepath.IsAbs(name) || !filepath.IsLocal(name) {
		return fmt.Errorf("checkoutfs: %q is not a path inside the checkout", name)
	}
	root, err := os.OpenRoot(checkout)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	if err := root.Remove(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("checkoutfs: clear %s: %w", name, err)
	}
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return fmt.Errorf("checkoutfs: create %s: %w", name, err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return fmt.Errorf("checkoutfs: write %s: %w", name, err)
	}
	return f.Close()
}

// Remove deletes name inside checkout if it is there, without following a
// symlink out of it.
func Remove(checkout, name string) error {
	root, err := os.OpenRoot(checkout)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	if err := root.Remove(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// ErrTooLarge means the file is longer than the reader takes.
var ErrTooLarge = errors.New("checkoutfs: file too large")

// Read reads name inside checkout, at most limit bytes: every path step is
// resolved inside the checkout (os.Root), so a symlink the PR planted to a
// file of the cell's is refused, never read.
func Read(checkout, name string, limit int64) ([]byte, error) {
	if name == "" || filepath.IsAbs(name) || !filepath.IsLocal(name) {
		return nil, fmt.Errorf("checkoutfs: %q is not a path inside the checkout", name)
	}
	root, err := os.OpenRoot(checkout)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	f, err := root.Open(name)
	if err != nil {
		return nil, fmt.Errorf("checkoutfs: open %s: %w", name, err)
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, fmt.Errorf("checkoutfs: read %s: %w", name, err)
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%w: %s is over %d bytes", ErrTooLarge, name, limit)
	}
	return b, nil
}
