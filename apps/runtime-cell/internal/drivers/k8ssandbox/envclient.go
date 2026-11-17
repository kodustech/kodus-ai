package k8ssandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// Kind is a namespaced resource the environment mode makes besides pods.
type Resource string

const (
	ResourceVolumeClaims    Resource = "persistentvolumeclaims"
	ResourceNetworkPolicies Resource = "networkpolicies"
)

func (r Resource) path(namespace string) (string, error) {
	switch r {
	case ResourceVolumeClaims:
		return "/api/v1/namespaces/" + url.PathEscape(namespace) + "/persistentvolumeclaims", nil
	case ResourceNetworkPolicies:
		return "/apis/networking.k8s.io/v1/namespaces/" + url.PathEscape(namespace) + "/networkpolicies", nil
	}
	return "", fmt.Errorf("k8ssandbox: resource %q is not one the cell makes", r)
}

// EnvAPI is what the environment mode asks of the cluster in the
// environment namespace: pods (KubeAPI), their logs, and the claim's
// volume claims and NetworkPolicy. The cell's Role there grants exactly
// these (EnvironmentNamespace).
type EnvAPI interface {
	KubeAPI
	CreateObject(ctx context.Context, namespace string, r Resource, obj Object) (Object, error)
	ListObjects(ctx context.Context, namespace string, r Resource, labels map[string]string) ([]Object, error)
	DeleteObject(ctx context.Context, namespace string, r Resource, name string) error
	// PodLogs is what the container logged since since (zero: from its
	// start), each line prefixed with the kubelet's RFC 3339 timestamp,
	// the last tail lines at most.
	PodLogs(ctx context.Context, namespace, pod, container string, since time.Time, tail int) ([]byte, error)
}

// CommandResult is one command's end: its output, bounded, and its exit
// code (-1 when the stream ended with no status).
type CommandResult struct {
	Stdout, Stderr []byte
	ExitCode       int
	// Truncated: a stream passed its bound and was cut.
	Truncated bool
}

// CommandRunner runs one command in a pod's container to its end: stdin
// written then closed, stdout and stderr kept up to maxOut bytes each.
type CommandRunner interface {
	RunCommand(ctx context.Context, namespace, pod, container string, argv []string, stdin []byte, maxOut int) (CommandResult, error)
	// StreamCommand runs argv with no stdin to its end and hands each line
	// it prints, stdout and stderr, to line as it comes (a build's
	// progress), keeping none; a line past maxLine bytes is cut there. It
	// returns the exit code (-1 when the stream ended with no status).
	StreamCommand(ctx context.Context, namespace, pod, container string, argv []string, line func(string)) (int, error)
}

// maxStreamLine bounds one line StreamCommand hands on.
const maxStreamLine = 16 << 10

// IsConflict reports the API server's 409 (the object exists).
func IsConflict(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Code == http.StatusConflict
}

func (c *Client) CreateObject(ctx context.Context, namespace string, r Resource, obj Object) (Object, error) {
	p, err := r.path(namespace)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(obj)
	if err != nil {
		return nil, err
	}
	out, err := c.do(ctx, http.MethodPost, p, nil, "application/json", body)
	if err != nil {
		return nil, err
	}
	return decode(out)
}

func (c *Client) ListObjects(ctx context.Context, namespace string, r Resource, labels map[string]string) ([]Object, error) {
	p, err := r.path(namespace)
	if err != nil {
		return nil, err
	}
	out, err := c.do(ctx, http.MethodGet, p, url.Values{"labelSelector": {labelSelector(labels)}}, "", nil)
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []Object `json:"items"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, err
	}
	return list.Items, nil
}

func (c *Client) DeleteObject(ctx context.Context, namespace string, r Resource, name string) error {
	p, err := r.path(namespace)
	if err != nil {
		return err
	}
	_, err = c.do(ctx, http.MethodDelete, p+"/"+url.PathEscape(name), nil, "", nil)
	return err
}

func (c *Client) PodLogs(ctx context.Context, namespace, pod, container string, since time.Time, tail int) ([]byte, error) {
	q := url.Values{"container": {container}, "timestamps": {"true"}}
	if !since.IsZero() {
		q.Set("sinceTime", since.UTC().Format(time.RFC3339))
	}
	if tail > 0 {
		q.Set("tailLines", strconv.Itoa(tail))
	}
	return c.do(ctx, http.MethodGet, podPath(namespace, pod)+"/log", q, "", nil)
}

// RunCommand runs argv in the container over pods/exec (v5.channel.k8s.io:
// stdin is closed with the close signal, so a command reading it to its end,
// tar -x, ends; an older server's v4 has no such signal and a command given
// stdin is refused there).
func (c *Client) RunCommand(ctx context.Context, namespace, pod, container string, argv []string, stdin []byte, maxOut int) (CommandResult, error) {
	if len(argv) == 0 {
		return CommandResult{}, errors.New("k8ssandbox: exec needs a command")
	}
	q := url.Values{"container": {container}, "stdout": {"true"}, "stderr": {"true"}}
	if stdin != nil {
		q.Set("stdin", "true")
	}
	for _, a := range argv {
		q.Add("command", a)
	}
	res := CommandResult{ExitCode: -1}
	keep := func(into *[]byte, b []byte) {
		if room := maxOut - len(*into); room >= len(b) {
			*into = append(*into, b...)
		} else {
			*into = append(*into, b[:max(room, 0)]...)
			res.Truncated = true
		}
	}
	code, err := c.execCommand(ctx, namespace, pod, q, stdin, func(ch byte, b []byte) {
		if ch == chanStdout {
			keep(&res.Stdout, b)
		} else {
			keep(&res.Stderr, b)
		}
	})
	res.ExitCode = code
	return res, err
}

// StreamCommand is RunCommand's stream: no stdin, every line to line.
func (c *Client) StreamCommand(ctx context.Context, namespace, pod, container string, argv []string, line func(string)) (int, error) {
	if len(argv) == 0 {
		return -1, errors.New("k8ssandbox: exec needs a command")
	}
	q := url.Values{"container": {container}, "stdout": {"true"}, "stderr": {"true"}}
	for _, a := range argv {
		q.Add("command", a)
	}
	var out, errs lineSplitter
	out.line, errs.line = line, line
	code, err := c.execCommand(ctx, namespace, pod, q, nil, func(ch byte, b []byte) {
		if ch == chanStdout {
			out.write(b)
		} else {
			errs.write(b)
		}
	})
	out.flush()
	errs.flush()
	return code, err
}

// lineSplitter hands on whole lines, a line cut at maxStreamLine.
type lineSplitter struct {
	buf  []byte
	line func(string)
}

func (l *lineSplitter) write(b []byte) {
	for len(b) > 0 {
		i := bytes.IndexByte(b, '\n')
		if i < 0 {
			l.buf = append(l.buf, b[:min(len(b), max(maxStreamLine-len(l.buf), 0))]...)
			return
		}
		l.buf = append(l.buf, b[:min(i, max(maxStreamLine-len(l.buf), 0))]...)
		l.flush()
		b = b[i+1:]
	}
}

func (l *lineSplitter) flush() {
	if len(l.buf) > 0 {
		l.line(strings.TrimRight(string(l.buf), "\r"))
		l.buf = l.buf[:0]
	}
}

// execCommand runs one exec to its end: stdin (when not nil) written then
// closed, each stdout and stderr message to out, the exit code from the
// status channel.
func (c *Client) execCommand(ctx context.Context, namespace, pod string, q url.Values, stdin []byte, out func(ch byte, b []byte)) (int, error) {
	h := http.Header{}
	if err := c.authorize(h); err != nil {
		return -1, err
	}
	hc := &http.Client{Transport: c.HTTP.Transport}
	conn, resp, err := websocket.Dial(ctx, strings.TrimRight(c.Base, "/")+podPath(namespace, pod)+"/exec?"+q.Encode(), &websocket.DialOptions{
		HTTPClient: hc, HTTPHeader: h, Subprotocols: []string{execProtoV5, execProtoV4},
	})
	if err != nil {
		if resp != nil {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusNotFound {
				return -1, ErrNotFound
			}
			return -1, statusError(http.MethodGet, podPath(namespace, pod)+"/exec", resp.StatusCode, body)
		}
		return -1, fmt.Errorf("k8ssandbox: exec %s/%s: %w", namespace, pod, err)
	}
	defer func() { _ = conn.CloseNow() }()
	conn.SetReadLimit(execReadLimit)
	if stdin != nil {
		if conn.Subprotocol() != execProtoV5 {
			return -1, errors.New("k8ssandbox: the API server's exec has no stdin close (v4): this command needs v5.channel.k8s.io")
		}
		for p := stdin; ; {
			n := min(len(p), execWriteChunk)
			msg := append([]byte{chanStdin}, p[:n]...)
			if err := conn.Write(ctx, websocket.MessageBinary, msg); err != nil {
				return -1, fmt.Errorf("k8ssandbox: exec stdin: %w", err)
			}
			if p = p[n:]; len(p) == 0 {
				break
			}
		}
		if err := conn.Write(ctx, websocket.MessageBinary, []byte{chanClose, chanStdin}); err != nil {
			return -1, fmt.Errorf("k8ssandbox: exec stdin close: %w", err)
		}
	}
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return -1, ctx.Err()
			}
			return -1, nil // the stream ended without a status
		}
		if len(msg) == 0 {
			continue
		}
		switch msg[0] {
		case chanStdout, chanStderr:
			out(msg[0], msg[1:])
		case chanStatus:
			return exitCode(msg[1:]), nil
		}
	}
}

// exitCode reads the exec's metav1.Status: Success is 0, a NonZeroExitCode
// names its code in details.causes, anything else is -1.
func exitCode(b []byte) int {
	var st struct {
		Status  string `json:"status"`
		Reason  string `json:"reason"`
		Details struct {
			Causes []struct {
				Reason  string `json:"reason"`
				Message string `json:"message"`
			} `json:"causes"`
		} `json:"details"`
	}
	if json.Unmarshal(b, &st) != nil {
		return -1
	}
	if st.Status == "Success" {
		return 0
	}
	for _, c := range st.Details.Causes {
		if c.Reason == "ExitCode" {
			if n, err := strconv.Atoi(c.Message); err == nil {
				return n
			}
		}
	}
	return -1
}

var (
	_ EnvAPI        = (*Client)(nil)
	_ CommandRunner = (*Client)(nil)
)
