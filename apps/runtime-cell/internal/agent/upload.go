package agent

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/composecmd"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

// The upload frame (docs §5): files written into the claim's checkout from
// the evidence store. Each file carries a read grant the worker signed for
// that one object of the claim's org (contentRef); the cell GETs it over its
// own path (EvidenceHTTP, the client artifacts are uploaded with), never
// from inside the machine, then writes the bytes in the machine through the
// transport's exec, which every driver that runs commands has.
const (
	// MaxUploadFileBytes bounds one file of an upload.
	MaxUploadFileBytes = 4 << 20
	// MaxUploadBytes bounds all the files of one upload.
	MaxUploadBytes = 16 << 20
	// uploadFetchTimeout bounds one GET of a read grant.
	uploadFetchTimeout = 30 * time.Second
	// uploadExecTimeoutMs bounds one write exec in the machine.
	uploadExecTimeoutMs = 60_000
	// uploadEnvChunk is the bytes of one env value: base64 of 6144 bytes is
	// 8192 characters, the most a guest op's env value takes.
	uploadEnvChunk = 6144
	// uploadEnvVars is how many env values one write exec carries (96 KiB).
	uploadEnvVars = 16
)

var errUploadBody = errors.New("upload")

// uploadCanon is what the at-most-once rule compares: every path, ref, digest
// and mode, never the grant URL, which the worker signs again on a retry.
func uploadCanon(b *protocol.UploadBody) []byte {
	var s strings.Builder
	s.WriteString("upload")
	for _, f := range b.Files {
		s.WriteString("\x00" + f.Path + "\x00" + f.ContentRef)
		if f.Sha256 != nil {
			s.WriteString("\x00sha256:" + *f.Sha256)
		}
		if f.Mode != nil {
			s.WriteString("\x00mode:" + strconv.FormatInt(*f.Mode, 8))
		}
	}
	return []byte(s.String())
}

// checkUpload refuses, before the step is admitted, what the cell never
// writes or fetches, whatever the hub checked: a path out of the checkout,
// in a .git directory or over the cell's own files; a grant that is not a
// plain http(s) URL; a mode with other bits than the permissions.
func checkUpload(b *protocol.UploadBody) error {
	if len(b.Files) == 0 || len(b.Files) > 256 {
		return fmt.Errorf("%w: %d files", errUploadBody, len(b.Files))
	}
	for i, f := range b.Files {
		if err := uploadPathOK(f.Path); err != nil {
			return fmt.Errorf("%w: files[%d].path: %v", errUploadBody, i, err)
		}
		u, err := url.Parse(f.URL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
			return fmt.Errorf("%w: files[%d].url is not an http(s) read grant", errUploadBody, i)
		}
		if f.Mode != nil && (*f.Mode < 0 || *f.Mode > 0o777) {
			return fmt.Errorf("%w: files[%d].mode", errUploadBody, i)
		}
		if f.Sha256 != nil {
			if d, err := hex.DecodeString(*f.Sha256); err != nil || len(d) != sha256.Size {
				return fmt.Errorf("%w: files[%d].sha256", errUploadBody, i)
			}
		}
	}
	return nil
}

func uploadPathOK(p string) error {
	if p == "" || len(p) > 1024 || strings.ContainsAny(p, "\\\x00\n") {
		return errors.New("empty, too long or with a backslash, NUL or newline")
	}
	segs := strings.Split(p, "/")
	for _, s := range segs {
		switch s {
		case "", ".", "..":
			return errors.New("an empty, . or .. segment")
		case ".git":
			return errors.New("inside a .git directory")
		}
	}
	if strings.HasPrefix(segs[0], ".kodus") || strings.HasPrefix(segs[0], ".kody") {
		return errors.New("over the cell's own files")
	}
	return nil
}

// runUpload fetches every file first (so a refused one writes nothing),
// then writes each in the machine; the result is ok, or an exec of exit 1
// whose stderr says why without the grant.
func (a *Agent) runUpload(ctx context.Context, c *claims.Claim, b *protocol.UploadBody) {
	workload := c.Machines().Workload
	start := a.clock.Now()
	res := &protocol.StepResultBody{StepID: b.StepID, Executor: protocol.ExecutorVM, ImageID: workload.ImageID, VMHealth: protocol.VMHealthOk}
	fail := func(why string) {
		d := a.clock.Now().Sub(start).Milliseconds()
		res.DurationMs = &d
		res.Exec = &protocol.ExecResult{ExitCode: 1, Stderr: why, DurationMs: d}
		c.Log.Warn("upload.failed", "step", b.StepID, "why", why)
		a.sendStepResult(ctx, c, "upload", res)
	}
	bodies := make([][]byte, len(b.Files))
	total := 0
	for i, f := range b.Files {
		body, err := a.fetchUpload(ctx, f, MaxUploadBytes-total)
		if a.stepCancelled(ctx, c, "upload", b.StepID, err) {
			return
		}
		if err != nil {
			fail(fmt.Sprintf("%s: %v", f.Path, err))
			return
		}
		bodies[i], total = body, total+len(body)
	}
	for i, f := range b.Files {
		mode := int64(0o644)
		if f.Mode != nil {
			mode = *f.Mode
		}
		err := a.writeInMachine(ctx, c, b.StepID, f.Path, bodies[i], mode)
		if a.stepCancelled(ctx, c, "upload", b.StepID, err) {
			return
		}
		var exit *uploadExitError
		switch {
		case errors.As(err, &exit):
			fail(fmt.Sprintf("%s: %v", f.Path, err))
			return
		case err != nil:
			c.Log.Warn("upload.transport_failed", "step", b.StepID, "err", err)
			res.VMHealth = protocol.VMHealthUnreachable
			a.sendStepResult(ctx, c, "upload", res)
			return
		}
	}
	d := a.clock.Now().Sub(start).Milliseconds()
	res.DurationMs = &d
	c.Log.Info("upload.done", "step", b.StepID, "files", len(b.Files), "bytes", total, "durationMs", d)
	a.sendStepResult(ctx, c, "upload", res)
}

// fetchUpload GETs one read grant: no redirect, 200 only, at most
// MaxUploadFileBytes and left bytes, the digest when the frame names one.
// No error names the URL, which carries the grant's signature.
func (a *Agent) fetchUpload(ctx context.Context, f protocol.UploadFile, left int) ([]byte, error) {
	limit := min(MaxUploadFileBytes, left)
	client := a.cfg.EvidenceHTTP
	if client == nil {
		client = &http.Client{Timeout: uploadFetchTimeout}
	}
	nc := *client
	nc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	fctx, cancel := context.WithTimeout(ctx, uploadFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(fctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return nil, errors.New("bad read grant")
	}
	resp, err := nc.Do(req)
	if err != nil {
		return nil, errors.New("evidence store unreachable")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("evidence store answered %d", resp.StatusCode)
	}
	if resp.ContentLength > int64(limit) {
		return nil, fmt.Errorf("over the upload bound of %d bytes", limit)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(limit)+1))
	if err != nil {
		return nil, errors.New("evidence store read failed")
	}
	if len(body) > limit {
		return nil, fmt.Errorf("over the upload bound of %d bytes", limit)
	}
	if f.Sha256 != nil {
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != *f.Sha256 {
			return nil, errors.New("bytes do not match the digest")
		}
	}
	return body, nil
}

// uploadExitError is a write the machine ran and refused (exit not 0).
type uploadExitError struct {
	code   int
	stderr string
}

func (e *uploadExitError) Error() string {
	return fmt.Sprintf("write in the machine exited %d: %s", e.code, strings.TrimSpace(e.stderr))
}

// writeInMachine writes data at rel under the checkout: base64 chunks in the
// exec env appended to a staging file next to rel, then chmod and a rename
// over rel (never into a directory rel names).
func (a *Agent) writeInMachine(ctx context.Context, c *claims.Claim, stepID, rel string, data []byte, mode int64) error {
	// Every path goes as ./<path>: none reads as an option, no "--" needed
	// (which not every chmod takes).
	q := func(p string) string { return composecmd.ShellQuote("./" + p) }
	dir := "."
	if i := strings.LastIndex(rel, "/"); i > 0 {
		dir = rel[:i]
	}
	tmp := dir + "/.kody-upload-" + stepID[:8] + "-" + strconv.Itoa(len(rel))
	run := func(cmd string, env []string) error {
		req := kodyexec.Request{Command: cmd, Cwd: transport.Workspace, TimeoutMs: uploadExecTimeoutMs, Env: env, Limits: a.cfg.ExecLimits}
		ectx, cancel := context.WithTimeout(ctx, uploadExecTimeoutMs*time.Millisecond+a.cfg.ExecGrace)
		defer cancel()
		out, err := a.cfg.Transport.Exec(ectx, c.Machines().Workload, req)
		if err != nil {
			return err
		}
		if out.ExitCode != 0 {
			return &uploadExitError{code: out.ExitCode, stderr: out.Stderr}
		}
		return nil
	}
	if err := run("set -e; mkdir -p "+q(dir)+"; rm -f "+q(tmp)+"; : > "+q(tmp), nil); err != nil {
		return err
	}
	per := uploadEnvChunk * uploadEnvVars
	for off := 0; off < len(data); off += per {
		part := data[off:min(off+per, len(data))]
		var env []string
		var refs strings.Builder
		for i := 0; i*uploadEnvChunk < len(part); i++ {
			name := "KODY_UPLOAD_" + strconv.Itoa(i)
			env = append(env, name+"="+base64.StdEncoding.EncodeToString(part[i*uploadEnvChunk:min((i+1)*uploadEnvChunk, len(part))]))
			refs.WriteString(`"$` + name + `"`)
		}
		// Each value is padded base64 on its own: decode them one by one.
		cmd := "set -e; for v in " + refs.String() + "; do printf '%s' \"$v\" | base64 -d >> " + q(tmp) + "; done"
		if err := run(cmd, env); err != nil {
			_ = run("rm -f "+q(tmp), nil)
			return err
		}
	}
	final := "set -e; if [ -d " + q(rel) + " ] && [ ! -L " + q(rel) + " ]; then rm -f " + q(tmp) + "; echo 'is a directory' >&2; exit 3; fi; " +
		"chmod " + strconv.FormatInt(mode, 8) + " " + q(tmp) + "; mv -f " + q(tmp) + " " + q(rel)
	return run(final, nil)
}
