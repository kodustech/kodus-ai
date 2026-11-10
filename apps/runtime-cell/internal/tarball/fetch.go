package tarball

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Revoker invalidates the download token once the code is in the cell
// (gitsource.GitHub is one).
type Revoker interface {
	Revoke(ctx context.Context, token string) error
}

// Extractor turns a downloaded tarball into a directory.
type Extractor interface {
	Extract(ctx context.Context, tarPath, dest string) (Stats, error)
}

// InProcessExtractor extracts in the cell agent itself. Tests and the fake
// cell only.
type InProcessExtractor struct{ Limits Limits }

func (p InProcessExtractor) Extract(_ context.Context, tarPath, dest string) (Stats, error) {
	f, err := os.Open(tarPath)
	if err != nil {
		return Stats{}, err
	}
	defer f.Close()
	return Extract(f, dest, p.Limits)
}

// NetNSExtractor runs the extraction in a child process with no network: on
// Linux in a new network and user namespace. Elsewhere it refuses to run
// unless AllowWithoutNetNS is set (development only).
type NetNSExtractor struct {
	// Command is the child, for example {"/usr/local/bin/cell", "extract"}.
	Command           []string
	AllowWithoutNetNS bool
}

func (i NetNSExtractor) Extract(ctx context.Context, tarPath, dest string) (Stats, error) {
	if len(i.Command) == 0 {
		return Stats{}, errors.New("tarball: isolated extractor without a command")
	}
	args := append(append([]string{}, i.Command[1:]...), "--src", tarPath, "--dest", dest)
	cmd := exec.CommandContext(ctx, i.Command[0], args...)
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	if err := isolate(cmd, i.AllowWithoutNetNS); err != nil {
		return Stats{}, err
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return Stats{}, fmt.Errorf("tarball: extractor: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	var st Stats
	if err := json.Unmarshal(stdout.Bytes(), &st); err != nil {
		return Stats{}, fmt.Errorf("tarball: extractor output: %w", err)
	}
	return st, nil
}

// RunExtractChild is the extractor process: cell extract --src x --dest y.
func RunExtractChild(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("extract", flag.ContinueOnError)
	fs.SetOutput(stderr)
	src := fs.String("src", "", "tarball path")
	dest := fs.String("dest", "", "empty destination directory")
	if err := fs.Parse(args); err != nil || *src == "" || *dest == "" {
		fmt.Fprintln(stderr, "usage: extract --src file.tar.gz --dest dir")
		return 2
	}
	st, err := InProcessExtractor{}.Extract(context.Background(), *src, *dest)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	_ = json.NewEncoder(stdout).Encode(st)
	return 0
}

type FetchOptions struct {
	Client    *http.Client
	URL       string // e.g. https://api.github.com/repos/o/r/tarball/<sha>
	Token     string
	Dest      string
	WorkDir   string
	MaxBytes  int64 // compressed download cap
	Extractor Extractor
	Revoker   Revoker
}

// revokeAttempts and revokeBackoff: a revocation is tried again on a
// network blip (the code is already in the cell by then), and still fails
// the fetch when every try does: a token left valid is never let go
// silently (S-05).
var (
	revokeAttempts = 3
	revokeBackoff  = time.Second
)

// FetchExtractRevoke downloads, extracts and revokes. The token is revoked
// on every path, including a refused archive or a failed download.
func FetchExtractRevoke(ctx context.Context, o FetchOptions) (st Stats, err error) {
	defer func() {
		var rerr error
		for i := 0; i < revokeAttempts; i++ {
			if i > 0 {
				time.Sleep(revokeBackoff << (i - 1))
			}
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			rerr = o.Revoker.Revoke(rctx, o.Token)
			cancel()
			if rerr == nil {
				break
			}
		}
		if rerr != nil {
			err = errors.Join(err, fmt.Errorf("token revocation (%d tries): %w", revokeAttempts, rerr))
		}
	}()
	if o.MaxBytes == 0 {
		o.MaxBytes = 2 << 30
	}
	c := o.Client
	if c == nil {
		c = &http.Client{Timeout: 10 * time.Minute}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.URL, nil)
	if err != nil {
		return st, err
	}
	req.Header.Set("Authorization", "Bearer "+o.Token)
	resp, err := c.Do(req)
	if err != nil {
		return st, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return st, fmt.Errorf("tarball: download status %d", resp.StatusCode)
	}
	tmp, err := os.CreateTemp(o.WorkDir, "repo-*.tar.gz")
	if err != nil {
		return st, err
	}
	defer os.Remove(tmp.Name())
	n, err := io.Copy(tmp, io.LimitReader(resp.Body, o.MaxBytes+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return st, err
	}
	if n > o.MaxBytes {
		return st, fmt.Errorf("tarball: download larger than %d bytes", o.MaxBytes)
	}
	if err := os.MkdirAll(o.Dest, 0o755); err != nil {
		return st, err
	}
	dest, _ := filepath.Abs(o.Dest)
	return o.Extractor.Extract(ctx, tmp.Name(), dest)
}
