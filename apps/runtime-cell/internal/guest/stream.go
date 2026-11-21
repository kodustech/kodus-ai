package guest

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/telemetry"
)

// The stream between the cell and the guest agent carries whole protocol
// frames (envelope and body, the same JSON the hub and the cell exchange),
// each after its length as 4 bytes big-endian. A frame is at most
// protocol.MaxFrameBytes; a longer length ends the stream.

// WriteFrame writes one frame.
func WriteFrame(w io.Writer, frame []byte) error {
	if len(frame) > protocol.MaxFrameBytes {
		return fmt.Errorf("guest: frame of %d bytes is over the limit", len(frame))
	}
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(frame))) //nolint:gosec // G115: bounded by MaxFrameBytes above
	if _, err := w.Write(append(n[:], frame...)); err != nil {
		return err
	}
	return nil
}

// ReadFrame reads one frame.
func ReadFrame(r io.Reader) ([]byte, error) {
	var n [4]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(n[:])
	if size > protocol.MaxFrameBytes {
		return nil, fmt.Errorf("guest: frame of %d bytes is over the limit", size)
	}
	frame := make([]byte, size)
	if _, err := io.ReadFull(r, frame); err != nil {
		return nil, err
	}
	return frame, nil
}

// NewID is a random UUID v4 (frame ids).
func NewID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ErrClosed is a client whose stream ended: the machine is gone or its
// guest agent died. The caller reports the step's machine unreachable.
var ErrClosed = errors.New("guest: the stream to the guest agent is closed")

// Client is the cell's side of one stream: requests go out as sandbox.op,
// answers come back as guest.result matched by re. Safe for concurrent use.
type Client struct {
	rw      io.ReadWriteCloser
	cellID  string
	claimID string
	// TraceContext puts the caller's traceparent on each sandbox.op (only for
	// a guest agent whose decoder takes the field: agent.Config.GuestTraceContext).
	TraceContext bool

	wmu     sync.Mutex
	mu      sync.Mutex
	pending map[string]chan protocol.SandboxResult
	closed  bool
	done    chan struct{}
}

// NewClient starts reading rw's answers. Close ends the stream.
func NewClient(rw io.ReadWriteCloser, cellID, claimID string) *Client {
	c := &Client{rw: rw, cellID: cellID, claimID: claimID, pending: map[string]chan protocol.SandboxResult{}, done: make(chan struct{})}
	go c.read()
	return c
}

func (c *Client) read() {
	defer c.shut()
	for {
		frame, err := ReadFrame(c.rw)
		if err != nil {
			return
		}
		m, err := protocol.Decode(frame)
		if err != nil || m.Envelope.Re == nil {
			return // a guest that speaks anything else is not trusted further
		}
		b, ok := m.Body.(*protocol.GuestResultBody)
		if !ok {
			return
		}
		c.mu.Lock()
		ch := c.pending[*m.Envelope.Re]
		delete(c.pending, *m.Envelope.Re)
		c.mu.Unlock()
		if ch != nil {
			ch <- b.Result
		}
	}
}

func (c *Client) shut() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	close(c.done)
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
	_ = c.rw.Close()
}

// Close ends the stream; calls in flight return ErrClosed.
func (c *Client) Close() error {
	c.shut()
	return nil
}

// Done is closed when the stream ends.
func (c *Client) Done() <-chan struct{} { return c.done }

// Do sends one op and waits for its answer, or ctx.
func (c *Client) Do(ctx context.Context, stepID string, op protocol.SandboxOp) (protocol.SandboxResult, error) {
	id := NewID()
	h := protocol.Header{ID: id, CellID: c.cellID, ClaimID: c.claimID}
	if c.TraceContext {
		h.Traceparent = telemetry.Traceparent(ctx)
	}
	frame, err := protocol.Encode(h, &protocol.SandboxOpBody{StepID: stepID, Op: op})
	if err != nil {
		return protocol.SandboxResult{}, err
	}
	ch := make(chan protocol.SandboxResult, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return protocol.SandboxResult{}, ErrClosed
	}
	c.pending[id] = ch
	c.mu.Unlock()
	c.wmu.Lock()
	err = WriteFrame(c.rw, frame)
	c.wmu.Unlock()
	if err != nil {
		c.shut()
		return protocol.SandboxResult{}, ErrClosed
	}
	select {
	case r, ok := <-ch:
		if !ok {
			return protocol.SandboxResult{}, ErrClosed
		}
		return r, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return protocol.SandboxResult{}, ctx.Err()
	}
}
