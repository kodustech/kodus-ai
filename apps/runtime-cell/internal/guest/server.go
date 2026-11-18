//go:build unix

package guest

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// MaxConcurrent is how many ops one stream runs at once; one more is
// answered busy, never queued without bound.
const MaxConcurrent = 16

// Serve answers the sandbox.op frames read from r on w until r ends or ctx
// does. Anything else on the stream ends it: only the cell talks here.
func Serve(ctx context.Context, r io.Reader, w io.Writer, fs *FS) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var (
		wmu  sync.Mutex
		wg   sync.WaitGroup
		slot = make(chan struct{}, MaxConcurrent)
	)
	defer wg.Wait()
	send := func(id, cellID, stepID string, res protocol.SandboxResult) {
		frame := encodeResult(id, cellID, stepID, res)
		wmu.Lock()
		defer wmu.Unlock()
		if err := WriteFrame(w, frame); err != nil {
			cancel()
		}
	}
	for {
		frame, err := ReadFrame(r)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		m, err := protocol.Decode(frame)
		if err != nil {
			return err
		}
		b, ok := m.Body.(*protocol.SandboxOpBody)
		if !ok {
			return errors.New("guest: only sandbox.op is served")
		}
		id, cellID := m.Envelope.ID, m.Envelope.CellID
		select {
		case slot <- struct{}{}:
		default:
			send(id, cellID, b.StepID, failed(refuse(protocol.SandboxErrorCodeBusy, "%d operations already run on this sandbox", MaxConcurrent)))
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-slot }()
			send(id, cellID, b.StepID, Run(ctx, fs, b.Op))
		}()
	}
}

func failed(err error) protocol.SandboxResult {
	var oe *opError
	if !errors.As(err, &oe) {
		oe = &opError{protocol.SandboxErrorCodeIo, err.Error()}
	}
	msg := oe.msg
	if len(msg) > 1_000 {
		msg = msg[:1_000]
	}
	return protocol.SandboxResult{Ok: false, Error: &protocol.SandboxError{Code: oe.code, Message: msg}}
}

// Run does one op on fs.
func Run(ctx context.Context, fs *FS, op protocol.SandboxOp) protocol.SandboxResult {
	if err := protocol.CheckSandboxOp(op); err != nil {
		return failed(refuse(protocol.SandboxErrorCodeInvalidPath, "%v", err))
	}
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	var (
		res protocol.SandboxResult
		err error
	)
	switch op.Op {
	case protocol.SandboxOpKindExec:
		res, err = fs.Exec(ctx, *op.Command, str(op.Cwd), op.Env, time.Duration(*op.TimeoutMs)*time.Millisecond)
	case protocol.SandboxOpKindRead:
		var off int64
		if op.Offset != nil {
			off = *op.Offset
		}
		res, err = fs.Read(*op.Path, off, op.ReadLength())
	case protocol.SandboxOpKindWrite:
		mode := uint32(0o644)
		if op.Mode != nil {
			mode = uint32(*op.Mode) //nolint:gosec // G115: the schema bounds mode to 0..0o777
		}
		res, err = fs.Write(*op.Path, *op.Content, mode, op.Append != nil && *op.Append, op.Mkdirs != nil && *op.Mkdirs)
	case protocol.SandboxOpKindList:
		depth, maxEntries := 1, protocol.SandboxListMaxEntries
		if op.Depth != nil {
			depth = int(*op.Depth)
		}
		if op.MaxEntries != nil {
			maxEntries = int(*op.MaxEntries)
		}
		res, err = fs.List(str(op.Path), depth, maxEntries)
	case protocol.SandboxOpKindStat:
		res, err = fs.Stat(str(op.Path))
	case protocol.SandboxOpKindRemove:
		res, err = fs.Remove(*op.Path)
	default:
		err = refuse(protocol.SandboxErrorCodeInvalidPath, "unknown op %q", op.Op)
	}
	if err != nil {
		return failed(err)
	}
	return res
}

// encodeResult is the guest.result frame, its exec output trimmed until the
// frame fits: escaped control bytes can make JSON six times the output.
func encodeResult(id, cellID, stepID string, res protocol.SandboxResult) []byte {
	for {
		frame, err := protocol.Encode(protocol.Header{ID: NewID(), Re: id, CellID: cellID}, &protocol.GuestResultBody{StepID: stepID, Result: res})
		if err == nil {
			return frame
		}
		if res.Exec == nil || (len(res.Exec.Stdout) == 0 && len(res.Exec.Stderr) == 0) {
			frame, _ = protocol.Encode(protocol.Header{ID: NewID(), Re: id, CellID: cellID}, &protocol.GuestResultBody{StepID: stepID, Result: failed(refuse(protocol.SandboxErrorCodeIo, "the result does not fit a frame"))})
			return frame
		}
		e := *res.Exec
		e.Stdout, _ = clean([]byte(e.Stdout), nil, len(e.Stdout)/2)
		e.Stderr, _ = clean([]byte(e.Stderr), nil, len(e.Stderr)/2)
		e.Truncated = true
		res.Exec = &e
	}
}
