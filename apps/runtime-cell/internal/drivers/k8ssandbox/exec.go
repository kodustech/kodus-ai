package k8ssandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// The API server's exec streams over WebSocket (channel.k8s.io): every
// message is one channel byte and its payload. v5 adds the close signal
// that ends a command's stdin; v4 is the fallback of an older server.
const (
	execProtoV5 = "v5.channel.k8s.io"
	execProtoV4 = "v4.channel.k8s.io"

	chanStdin  = 0
	chanStdout = 1
	chanStderr = 2
	chanStatus = 3
	chanClose  = 255

	// execReadLimit bounds one message from the API server (a guest agent
	// frame carries at most a file chunk or a command's clipped output).
	execReadLimit = 32 << 20
	// execWriteChunk keeps each stdin message small: the API server relays
	// it to the kubelet as it comes.
	execWriteChunk = 32 << 10
	// stderrKeep is how much of the command's stderr the stream keeps for
	// its error: the guest agent writes its own failures there.
	stderrKeep = 4 << 10
)

// Exec runs command in the pod's container with stdin, stdout and stderr
// attached, over a WebSocket to the API server (pods/exec). The stream's
// Read is the command's stdout; stderr is kept, bounded, for Err.
func (c *Client) Exec(ctx context.Context, namespace, pod, container string, command []string) (io.ReadWriteCloser, error) {
	if len(command) == 0 {
		return nil, errors.New("k8ssandbox: exec needs a command")
	}
	q := url.Values{"container": {container}, "stdin": {"true"}, "stdout": {"true"}, "stderr": {"true"}}
	for _, a := range command {
		q.Add("command", a)
	}
	h := http.Header{}
	if err := c.authorize(h); err != nil {
		return nil, err
	}
	// No client timeout: it would cut the stream, which lives as long as
	// the sandbox. The context bounds the handshake only.
	hc := &http.Client{Transport: c.HTTP.Transport}
	conn, resp, err := websocket.Dial(ctx, strings.TrimRight(c.Base, "/")+podPath(namespace, pod)+"/exec?"+q.Encode(), &websocket.DialOptions{
		HTTPClient: hc, HTTPHeader: h, Subprotocols: []string{execProtoV5, execProtoV4},
	})
	if err != nil {
		if resp != nil {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusNotFound {
				return nil, ErrNotFound
			}
			return nil, statusError(http.MethodGet, podPath(namespace, pod)+"/exec", resp.StatusCode, body)
		}
		return nil, fmt.Errorf("k8ssandbox: exec %s/%s: %w", namespace, pod, err)
	}
	conn.SetReadLimit(execReadLimit)
	return &execStream{conn: conn, v5: conn.Subprotocol() == execProtoV5}, nil
}

// execStream is one exec's stdin and stdout as a byte stream.
type execStream struct {
	conn *websocket.Conn
	v5   bool

	// Read side: one reader at a time (the guest client's read loop).
	pending []byte
	done    bool

	mu     sync.Mutex
	stderr []byte
	status string
	closed bool
}

func (s *execStream) Read(p []byte) (int, error) {
	for len(s.pending) == 0 {
		if s.done {
			return 0, io.EOF
		}
		_, msg, err := s.conn.Read(context.Background())
		if err != nil {
			s.done = true
			return 0, io.EOF
		}
		if len(msg) == 0 {
			continue
		}
		switch msg[0] {
		case chanStdout:
			s.pending = msg[1:]
		case chanStderr:
			s.mu.Lock()
			if room := stderrKeep - len(s.stderr); room > 0 {
				s.stderr = append(s.stderr, msg[1:min(len(msg), room+1)]...)
			}
			s.mu.Unlock()
		case chanStatus:
			// The command ended: a metav1.Status, Success or the exit code.
			var st struct {
				Status  string `json:"status"`
				Message string `json:"message"`
			}
			_ = json.Unmarshal(msg[1:], &st)
			s.mu.Lock()
			s.status = strings.TrimSpace(st.Status + " " + st.Message)
			s.mu.Unlock()
			s.done = true
		}
	}
	n := copy(p, s.pending)
	s.pending = s.pending[n:]
	return n, nil
}

func (s *execStream) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		n := min(len(p), execWriteChunk)
		msg := make([]byte, 1+n)
		msg[0] = chanStdin
		copy(msg[1:], p[:n])
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		err := s.conn.Write(ctx, websocket.MessageBinary, msg)
		cancel()
		if err != nil {
			return written, fmt.Errorf("k8ssandbox: exec stdin: %w", err)
		}
		written += n
		p = p[n:]
	}
	return written, nil
}

// Close ends the command's stdin (v5) and the stream.
func (s *execStream) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	if s.v5 {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = s.conn.Write(ctx, websocket.MessageBinary, []byte{chanClose, chanStdin})
		cancel()
	}
	return s.conn.CloseNow()
}

// Err is what the command left on stderr and its exit status, once it
// ended; empty while it runs.
func (s *execStream) Err() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.TrimSpace(s.status + " " + string(s.stderr))
}
