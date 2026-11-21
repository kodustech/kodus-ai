// Package transport carries setup and evidence commands from the cell agent
// to a machine. On EC2 it is SSH over the private address with a per-claim
// key that never leaves the cell; the fake cell uses a local directory.
package transport

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

type Transport interface {
	Exec(ctx context.Context, ref driver.MachineRef, req kodyexec.Request) (kodyexec.Result, error)
	// Upload copies a local directory (the extracted repo) to dst on the
	// machine. Output takes the lines a transport that boots on upload
	// prints (local-docker's compose); nil: nobody listens.
	Upload(ctx context.Context, ref driver.MachineRef, srcDir, dst string, output func(line string)) error
}

// Local runs each machine as a directory under Root, with no isolation: the
// fake cell, and the dev-only local-docker driver, whose transport wraps it.
type Local struct{ Root string }

func (l Local) machineDir(ref driver.MachineRef) (string, error) {
	if ref.MachineID == "" || strings.ContainsAny(ref.MachineID, `/\.`) {
		return "", errors.New("transport: bad machine id")
	}
	dir := filepath.Join(l.Root, ref.MachineID)
	return dir, os.MkdirAll(dir, 0o755) //nolint:gosec // G301: fake cell and local-docker only (Local); a developer's scratch machine dir
}

func resolveInside(base, rel string) (string, error) {
	p := filepath.Join(base, filepath.FromSlash(rel))
	r, err := filepath.Rel(base, p)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", errors.New("transport: path outside the machine")
	}
	return p, nil
}

func (l Local) Exec(ctx context.Context, ref driver.MachineRef, req kodyexec.Request) (kodyexec.Result, error) {
	dir, err := l.machineDir(ref)
	if err != nil {
		return kodyexec.Result{}, err
	}
	cwd, err := resolveInside(dir, req.Cwd)
	if err != nil {
		return kodyexec.Result{}, err
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil { //nolint:gosec // G301: fake cell and local-docker only (Local); a developer's scratch machine dir
		return kodyexec.Result{}, err
	}
	req.Cwd = cwd
	return kodyexec.Run(ctx, req), nil
}

func (l Local) Upload(_ context.Context, ref driver.MachineRef, srcDir, dst string, _ func(string)) error {
	dir, err := l.machineDir(ref)
	if err != nil {
		return err
	}
	target, err := resolveInside(dir, dst)
	if err != nil {
		return err
	}
	return filepath.WalkDir(srcDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(srcDir, p)
		out := filepath.Join(target, rel)
		if d.Type()&fs.ModeSymlink != 0 {
			return errors.New("transport: symlink in upload")
		}
		if d.IsDir() {
			return os.MkdirAll(out, 0o755) //nolint:gosec // G301: fake cell and local-docker only (Local); a developer's scratch machine dir
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		in, err := os.Open(p) //nolint:gosec // G304: p is a file WalkDir found under the cell's own srcDir
		if err != nil {
			return err
		}
		defer func() { _ = in.Close() }()
		f, err := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm()) //nolint:gosec // G304: out is under target, which resolveInside kept inside the machine dir
		if err != nil {
			return err
		}
		_, err = io.Copy(f, in)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		return err
	})
}
