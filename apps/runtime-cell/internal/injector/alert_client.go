package injector

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
)

// AlertClient long-polls the injector's GET /v1/alerts (its control port,
// mTLS with the cell identity): the agent's side of the alert feed.
type AlertClient struct {
	// URL is the injector's control URL (https://host:9445).
	URL  string
	HTTP *http.Client
	// Wait is how long one poll waits for an alert (default 25 s, at most
	// eventlog.MaxWait on the server).
	Wait  time.Duration
	mu    sync.Mutex
	epoch string
	next  int64
}

// maxAlertsBody bounds one answer (the log keeps at most 10k alerts).
const maxAlertsBody = 4 << 20

// After returns the alerts with a sequence number past after, waiting up to
// Wait for one.
func (c *AlertClient) After(ctx context.Context, after int64) ([]Alert, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if after != c.next {
		return nil, &eventlog.FeedError{Reason: eventlog.ReasonCursorInvalid}
	}
	wait := c.Wait
	if wait <= 0 {
		wait = 25 * time.Second
	}
	if c.epoch == "" {
		wait = 0
	}
	q := url.Values{"after": {strconv.FormatInt(after, 10)}, "wait": {wait.String()}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.URL, "/")+"/v1/alerts?"+q.Encode(), nil)
	if err != nil {
		return nil, &eventlog.FeedError{Reason: eventlog.ReasonUnavailable}
	}
	req.Header.Set(eventlog.HeaderVersion, eventlog.Version)
	if c.epoch != "" {
		req.Header.Set(eventlog.HeaderEpoch, c.epoch)
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, &eventlog.FeedError{Reason: eventlog.ReasonUnavailable}
	}
	defer resp.Body.Close()
	version, valid := oneHeader(resp.Header, eventlog.HeaderVersion)
	if !valid || version != eventlog.Version {
		return nil, &eventlog.FeedError{Reason: eventlog.ReasonUnsupported}
	}
	epoch, okEpoch := oneHeader(resp.Header, eventlog.HeaderEpoch)
	oldest, okOldest := boundHeader(resp.Header, eventlog.HeaderOldest)
	latest, okLatest := boundHeader(resp.Header, eventlog.HeaderLatest)
	continuity, okContinuity := oneHeader(resp.Header, eventlog.HeaderContinuity)
	if !okEpoch || !validEpoch(epoch) || !okOldest || !okLatest || !okContinuity || oldest < 1 || oldest > latest+1 || latest == int64(^uint64(0)>>1) {
		return nil, &eventlog.FeedError{Reason: eventlog.ReasonInvalid}
	}
	reason := eventlog.ReasonOK
	switch {
	case c.epoch != "" && c.epoch != epoch:
		reason = eventlog.ReasonProducerRestart
	case after > latest:
		reason = eventlog.ReasonCursorInvalid
	case after < oldest-1:
		reason = eventlog.ReasonRetentionGap
	}
	if reason != eventlog.ReasonOK {
		return nil, &eventlog.FeedError{Reason: reason}
	}
	if resp.StatusCode != http.StatusOK || continuity != string(eventlog.ReasonOK) {
		return nil, &eventlog.FeedError{Reason: eventlog.ReasonInvalid}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAlertsBody+1))
	if err != nil || len(body) > maxAlertsBody {
		return nil, &eventlog.FeedError{Reason: eventlog.ReasonInvalid}
	}
	var out []Alert
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&out); err != nil || out == nil {
		return nil, &eventlog.FeedError{Reason: eventlog.ReasonInvalid}
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, &eventlog.FeedError{Reason: eventlog.ReasonInvalid}
	}
	next := after
	for _, alert := range out {
		if alert.Seq != next+1 || alert.Seq > latest {
			return nil, &eventlog.FeedError{Reason: eventlog.ReasonInvalid}
		}
		next = alert.Seq
	}
	if next != latest {
		return nil, &eventlog.FeedError{Reason: eventlog.ReasonInvalid}
	}
	c.epoch, c.next = epoch, next
	return out, nil
}

func oneHeader(h http.Header, key string) (string, bool) {
	values := h.Values(key)
	return h.Get(key), len(values) == 1 && values[0] != "" && len(values[0]) <= 64
}

func boundHeader(h http.Header, key string) (int64, bool) {
	v, ok := oneHeader(h, key)
	n, err := strconv.ParseInt(v, 10, 64)
	return n, ok && err == nil && n >= 0 && strconv.FormatInt(n, 10) == v
}

func validEpoch(v string) bool {
	if len(v) != 26 {
		return false
	}
	for _, c := range v {
		if !(c >= 'A' && c <= 'Z' || c >= '2' && c <= '7') {
			return false
		}
	}
	return true
}
