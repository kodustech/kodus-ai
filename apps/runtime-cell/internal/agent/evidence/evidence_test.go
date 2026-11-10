package evidence

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

var now = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

func collector(accepts bool) *Collector {
	return &Collector{Clock: clock.NewFake(now), Accepts: func(string) bool { return accepts }}
}

func claim() Claim {
	return Claim{ID: "claim-1", Log: slog.New(slog.DiscardHandler), Redactor: redact.New()}
}

func request(url string, max int64, expires time.Time) *protocol.EvidenceRequest {
	return &protocol.EvidenceRequest{
		Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureCast},
		Uploads: []protocol.UploadGrant{{Type: protocol.EvidenceUploadTypeCast, URL: url, ContentType: protocol.EvidenceContentTypeTextPlain, MaxBytes: max, ExpiresAt: protocol.FormatTime(expires)}},
	}
}

// A capture counts only when the step asked for it and the hub accepts the
// field that carries it.
func TestACaptureNeedsTheAskAndAHubThatAcceptsIt(t *testing.T) {
	req := request("http://unused", 10, now.Add(time.Minute))
	if !collector(true).Asked(req, protocol.EvidenceCaptureCast, protocol.FeatureExecCast) {
		t.Fatal("an asked capture a hub accepts was dropped")
	}
	if collector(false).Asked(req, protocol.EvidenceCaptureCast, protocol.FeatureExecCast) {
		t.Fatal("a capture went to a hub that does not accept its field")
	}
	if collector(true).Asked(req, protocol.EvidenceCaptureLogs, protocol.FeatureServiceLogs) || collector(true).Asked(nil, protocol.EvidenceCaptureCast, protocol.FeatureExecCast) {
		t.Fatal("a capture nobody asked for")
	}
}

// An artifact goes out only with its grant: the grant's content type, within
// its bytes, before it expires, and never to where a redirect points.
func TestAnUploadKeepsToItsGrant(t *testing.T) {
	var got []byte
	elsewhere := 0
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { elsewhere++ }))
	defer other.Close()
	store := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
			return
		}
		got, _ = io.ReadAll(r.Body)
		if r.Method != http.MethodPut || r.Header.Get("Content-Type") != string(protocol.EvidenceContentTypeTextPlain) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer store.Close()
	c, ctx, plain := collector(true), context.Background(), protocol.EvidenceContentTypeTextPlain
	put := func(req *protocol.EvidenceRequest, ct protocol.EvidenceContentType, body string) *protocol.EvidenceRef {
		return c.Upload(ctx, claim(), req, protocol.EvidenceUploadTypeCast, ct, []byte(body), false, 2)
	}
	ref := put(request(store.URL+"/cast", 10, now.Add(time.Minute)), plain, "hello")
	if ref == nil || string(got) != "hello" || ref.Bytes != 5 || ref.Redactions != 2 || len(ref.Sha256) != 64 {
		t.Fatalf("upload: %+v, store got %q", ref, got)
	}
	for name, ref := range map[string]*protocol.EvidenceRef{
		"over the grant's bytes": put(request(store.URL+"/cast", 4, now.Add(time.Minute)), plain, "hello"),
		"an expired grant":       put(request(store.URL+"/cast", 10, now), plain, "hello"),
		"another content type":   put(request(store.URL+"/cast", 10, now.Add(time.Minute)), protocol.EvidenceContentType("image/png"), "hello"),
		"a redirect":             put(request(store.URL+"/redirect", 10, now.Add(time.Minute)), plain, "hello"),
		"no grant":               c.Upload(ctx, claim(), &protocol.EvidenceRequest{}, protocol.EvidenceUploadTypeCast, plain, []byte("x"), false, 0),
	} {
		if ref != nil {
			t.Errorf("%s was uploaded: %+v", name, ref)
		}
	}
	if elsewhere != 0 {
		t.Fatal("the upload followed a redirect")
	}
}
