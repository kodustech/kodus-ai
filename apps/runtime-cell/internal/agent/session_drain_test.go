package agent

import (
	"context"
	"crypto/tls"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// slowExpiry is the fake driver with a SetExpiry that holds its machines'
// tag write until its context ends, then takes a moment more.
type slowExpiry struct {
	*fake.Driver
	started  chan struct{}
	finished atomic.Bool
}

func (d *slowExpiry) SetExpiry(ctx context.Context, ref driver.MachineRef, at time.Time) error {
	select {
	case d.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	time.Sleep(50 * time.Millisecond)
	d.finished.Store(true)
	return ctx.Err()
}

// A session returns only once its read loop and the deferred answers it
// started have ended: none of them may run claim work after Run moved on to
// Wait, or overlap the next session's handlers. Before, the session
// returned on heartbeat silence while a deferred claim.renew still ran.
func TestASessionEndsOnlyAfterItsDeferredAnswers(t *testing.T) {
	var drv *slowExpiry
	h := newHarness(t, func(c *Config) {
		drv = &slowExpiry{Driver: c.Driver.(*fake.Driver), started: make(chan struct{}, 1)}
		c.Driver = drv
	})
	h.ready("claim-1")

	ca, err := testpki.NewCA("session-drain-test")
	if err != nil {
		t.Fatal(err)
	}
	serverCert, _ := ca.Issue("hub", time.Hour, "127.0.0.1")
	clientCert, _ := ca.Issue("cell-1", time.Hour)
	until := protocol.FormatTime(h.clk.Now().Add(20 * time.Minute))
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			m, err := protocol.Decode(data)
			if err != nil {
				continue
			}
			if _, ok := m.Body.(*protocol.HelloBody); !ok {
				continue // heartbeats and the renew's answer go unanswered
			}
			v := protocol.SupportedVersions()[0]
			ack, _ := protocol.Encode(protocol.Header{ID: hubclient.NewID(), CellID: m.Envelope.CellID, Re: m.Envelope.ID}, &protocol.AckBody{Version: &v})
			renew, _ := protocol.Encode(protocol.Header{ID: hubclient.NewID(), CellID: m.Envelope.CellID, ClaimID: "claim-1"}, &protocol.ClaimRenewBody{LeaseExpiresAt: until})
			_ = ws.Write(ctx, websocket.MessageText, ack)
			_ = ws.Write(ctx, websocket.MessageText, renew)
		}
	}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert}
	srv.StartTLS()
	t.Cleanup(func() { srv.CloseClientConnections(); srv.Close() })
	url := "wss://" + strings.TrimPrefix(srv.URL, "https://")
	tlsCfg := &tls.Config{Certificates: []tls.Certificate{clientCert}, RootCAs: ca.Pool()}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ended := make(chan error, 1)
	go func() {
		ended <- h.a.session(ctx, RunConfig{HubURL: url, TLS: tlsCfg, HeartbeatEvery: 20 * time.Millisecond, AckTimeout: 300 * time.Millisecond, MissedHeartbeats: 1})
	}()
	select {
	case <-drv.started:
	case <-ctx.Done():
		t.Fatal("the hub's claim.renew never reached the driver")
	}
	select {
	case <-ended:
	case <-ctx.Done():
		t.Fatal("the session never ended")
	}
	if !drv.finished.Load() {
		t.Fatal("the session returned while its deferred claim.renew still ran")
	}
}
