package firecracker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// api is Firecracker's HTTP API on a machine's unix socket.
type api struct{ sock string }

// apiTimeout bounds one API call; a snapshot's create takes more
// (createTimeout).
var apiTimeout = 30 * time.Second

// createTimeout bounds a snapshot's create: the VMM writes the whole guest
// memory before it answers, at the disk's pace when the host's page cache
// is full of dirty pages (a 1 GiB sandbox took over 30 s on gp3 right after
// a 3 GB write).
func createTimeout(memMB int) time.Duration {
	return apiTimeout + time.Duration(memMB)*2*time.Minute/1024
}

func (a api) client(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", a.sock)
		},
	}}
}

func (a api) do(ctx context.Context, method, path string, body any, out any) error {
	return a.doWithin(ctx, apiTimeout, method, path, body, out)
}

func (a api) doWithin(ctx context.Context, timeout time.Duration, method, path string, body any, out any) error {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://firecracker"+path, r)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client(timeout).Do(req)
	if err != nil {
		return fmt.Errorf("firecracker: %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("firecracker: %s %s: %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out != nil && len(raw) > 0 {
		return json.Unmarshal(raw, out)
	}
	return nil
}

// state is the VM's state ("Running", "Paused", "Not started").
func (a api) state(ctx context.Context) (string, error) {
	var info struct {
		State string `json:"state"`
	}
	err := a.do(ctx, http.MethodGet, "/", nil, &info)
	return info.State, err
}

func (a api) setState(ctx context.Context, state string) error {
	return a.do(ctx, http.MethodPatch, "/vm", map[string]string{"state": state}, nil)
}
