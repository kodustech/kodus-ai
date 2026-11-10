// Package hubstub is a minimal runtime-hub for tests (test fakes live under
// internal/testing, never linked into a cell binary). It keeps the hub's side of the rules that the cell
// relies on: mTLS with the cell CA, certificate CN equal to the cellId,
// revocation, ack in 5 s, step.result accepted only for a step it sent on
// that connection (S-15, S-30), the hello ack carrying the chosen protocol
// version, and claim.ready / claim.failed only for a claim it asked that
// cell to acquire (a claim is bound only on claim.ready), acked again when
// resent for a claim it already settled the same way.
package hubstub

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type Event struct {
	CellID  string
	ClaimID string
	Type    protocol.MessageType
	Body    any
}

type session struct {
	cellID string
	ws     *websocket.Conn
	wmu    sync.Mutex
	steps  map[string]string // stepId -> claimId sent on this connection
	smu    sync.Mutex
}

// Claim states as the stub tracks them.
const (
	ClaimAcquiring = "acquiring"
	ClaimReady     = "ready"
)

type claimRecord struct {
	cellID string
	state  string
	failed bool
}

type Hub struct {
	Log *slog.Logger
	// HelloAck, when set before cells connect, replaces the hello ack
	// (default: {"version": protocol.ProtocolVersion}).
	HelloAck func() *protocol.AckBody

	mu       sync.Mutex
	sessions map[string]*session
	pending  map[string]chan *protocol.Message
	revoked  map[string]bool // certificate serials
	claims   map[string]*claimRecord
	events   chan Event
	hello    chan string
	// held keeps the events a WaitFor read and did not match, for the next
	// WaitFor: waiting for B never loses an A a test waits for later.
	heldMu sync.Mutex
	held   []Event

	Violations atomic.Int64
	// DropSettle drops the next N claim.ready / claim.failed frames as if
	// lost on the wire (no ack, no event); DropSettleAck settles the next N
	// but loses the ack. Settled counts the frames that settled a claim
	// (resends of a settled claim are acked and not counted).
	DropSettle    atomic.Int64
	DropSettleAck atomic.Int64
	Settled       atomic.Int64
}

func New() *Hub {
	return &Hub{
		Log:      slog.Default(),
		sessions: map[string]*session{},
		pending:  map[string]chan *protocol.Message{},
		revoked:  map[string]bool{},
		claims:   map[string]*claimRecord{},
		events:   make(chan Event, 256),
		hello:    make(chan string, 16),
	}
}

// TLSConfig requires a client certificate from the cell CA and refuses
// revoked serials during the handshake.
func (h *Hub) TLSConfig(server tls.Certificate, cellCA *x509.CertPool) *tls.Config {
	return &tls.Config{
		Certificates: []tls.Certificate{server},
		ClientCAs:    cellCA,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS13,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("no client certificate")
			}
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.revoked[cs.PeerCertificates[0].SerialNumber.String()] {
				return errors.New("certificate revoked")
			}
			return nil
		},
	}
}

func (h *Hub) Revoke(serial *big.Int) {
	h.mu.Lock()
	h.revoked[serial.String()] = true
	h.mu.Unlock()
}

// Events delivers every request frame the cells send (hello, heartbeat,
// step.result, blocked...).
func (h *Hub) Events() <-chan Event { return h.events }

// Hellos delivers the cellId of each connection that said hello.
func (h *Hub) Hellos() <-chan string { return h.hello }

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		http.Error(w, "mTLS required", http.StatusUnauthorized)
		return
	}
	cn := r.TLS.PeerCertificates[0].Subject.CommonName
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	ws.SetReadLimit(protocol.MaxFrameBytes)
	s := &session{cellID: cn, ws: ws, steps: map[string]string{}}
	defer ws.CloseNow()
	ctx := r.Context()
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			h.drop(s)
			return
		}
		if typ != websocket.MessageText {
			h.Violations.Add(1)
			continue
		}
		m, err := protocol.Decode(data)
		if err != nil {
			h.Violations.Add(1)
			h.reply(ctx, s, "", "", &hubclient.NackError{Code: "invalid_frame", Message: err.Error()})
			continue
		}
		if m.Envelope.CellID != cn {
			// A cell speaking for another cell: protocol.violation.
			h.Violations.Add(1)
			h.reply(ctx, s, m.Envelope.ID, "", &hubclient.NackError{Code: "protocol.violation", Message: "cellId does not match the certificate"})
			_ = ws.Close(websocket.StatusPolicyViolation, "cell identity")
			h.drop(s)
			return
		}
		claim := ""
		if m.Envelope.ClaimID != nil {
			claim = *m.Envelope.ClaimID
		}
		switch b := m.Body.(type) {
		case *protocol.AckBody, *protocol.NackBody:
			if m.Envelope.Re != nil {
				h.mu.Lock()
				ch, ok := h.pending[*m.Envelope.Re]
				h.mu.Unlock()
				if ok {
					select { // a second answer never blocks the read loop
					case ch <- m:
					default:
					}
				}
			}
			continue
		case *protocol.HelloBody:
			h.mu.Lock()
			h.sessions[cn] = s
			helloAck := h.HelloAck
			h.mu.Unlock()
			v := int64(protocol.ProtocolVersion)
			ack := &protocol.AckBody{Version: &v}
			if helloAck != nil {
				ack = helloAck()
			}
			h.replyBody(ctx, s, m.Envelope.ID, claim, ack)
			select {
			case h.hello <- cn:
			default:
			}
		case *protocol.StepResultBody:
			s.smu.Lock()
			owner, sent := s.steps[b.StepID]
			s.smu.Unlock()
			if !sent || owner != claim {
				h.Violations.Add(1)
				h.reply(ctx, s, m.Envelope.ID, claim, &hubclient.NackError{Code: "protocol.violation", Message: "step.result for a step not sent on this connection"})
				continue
			}
			h.reply(ctx, s, m.Envelope.ID, claim, nil)
		case *protocol.ClaimReadyBody, *protocol.ClaimFailedBody:
			if dropOne(&h.DropSettle) {
				continue
			}
			first, ok := h.settle(cn, claim, m.Envelope.Type)
			if !ok {
				h.Violations.Add(1)
				h.reply(ctx, s, m.Envelope.ID, claim, &hubclient.NackError{Code: "protocol.violation", Message: string(m.Envelope.Type) + " for a claim this cell was not acquiring"})
				continue
			}
			if !dropOne(&h.DropSettleAck) {
				h.reply(ctx, s, m.Envelope.ID, claim, nil)
			}
			if !first {
				continue // a resend: acked, already reported
			}
			h.Settled.Add(1)
		default:
			h.reply(ctx, s, m.Envelope.ID, claim, nil)
		}
		select {
		case h.events <- Event{CellID: cn, ClaimID: claim, Type: m.Envelope.Type, Body: m.Body}:
		default:
			h.Log.Warn("hubstub.events_full")
		}
	}
}

func (h *Hub) drop(s *session) {
	h.mu.Lock()
	if h.sessions[s.cellID] == s {
		delete(h.sessions, s.cellID)
	}
	h.mu.Unlock()
}

func (h *Hub) write(ctx context.Context, s *session, frame []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	return s.ws.Write(ctx, websocket.MessageText, frame)
}

func dropOne(n *atomic.Int64) bool {
	for {
		v := n.Load()
		if v <= 0 {
			return false
		}
		if n.CompareAndSwap(v, v-1) {
			return true
		}
	}
}

// settle moves an acquiring claim to ready (claim.ready) or failed
// (claim.failed); first is false for a resend of the same outcome. Anything
// else is a violation.
func (h *Hub) settle(cellID, claimID string, t protocol.MessageType) (first, ok bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, found := h.claims[claimID]
	if claimID == "" || !found || r.cellID != cellID {
		return false, false
	}
	failed := t == protocol.MessageTypeClaimFailed
	switch {
	case r.state == ClaimAcquiring:
		if failed {
			r.state, r.failed = "", true
		} else {
			r.state = ClaimReady
		}
		return true, true
	case r.state == ClaimReady && !failed, r.failed && failed:
		return false, true
	}
	return false, false
}

// ClaimState is "acquiring", "ready" or "" (unknown, failed or released).
func (h *Hub) ClaimState(claimID string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.claims[claimID]; ok {
		return r.state
	}
	return ""
}

func (h *Hub) reply(ctx context.Context, s *session, re, claim string, err error) {
	var body any = &protocol.AckBody{}
	var n *hubclient.NackError
	if errors.As(err, &n) {
		msg := n.Message
		if len(msg) > 1024 {
			msg = msg[:1024]
		}
		body = &protocol.NackBody{Code: n.Code, Message: msg}
	}
	h.replyBody(ctx, s, re, claim, body)
}

func (h *Hub) replyBody(ctx context.Context, s *session, re, claim string, body any) {
	hd := protocol.Header{ID: hubclient.NewID(), Re: re, CellID: s.cellID, ClaimID: claim}
	frame, eerr := protocol.Encode(hd, body)
	if eerr == nil {
		_ = h.write(ctx, s, frame)
	}
}

// Send delivers a request to a connected cell and waits for ack or nack.
func (h *Hub) Send(ctx context.Context, cellID, claimID string, body any) error {
	h.mu.Lock()
	s, ok := h.sessions[cellID]
	h.mu.Unlock()
	if !ok {
		return fmt.Errorf("hubstub: cell %s not connected", cellID)
	}
	switch b := body.(type) {
	case *protocol.ProbeRunBody:
		s.remember(b.StepID, claimID)
	case *protocol.ExecBody:
		s.remember(b.StepID, claimID)
	case *protocol.MachineResetBody:
		s.remember(b.StepID, claimID)
	}
	created := false
	h.mu.Lock()
	switch body.(type) {
	case *protocol.ClaimAcquireBody:
		if _, ok := h.claims[claimID]; !ok && claimID != "" {
			h.claims[claimID] = &claimRecord{cellID: cellID, state: ClaimAcquiring}
			created = true
		}
	case *protocol.ClaimReleaseBody:
		delete(h.claims, claimID)
	}
	h.mu.Unlock()
	id := hubclient.NewID()
	frame, err := protocol.Encode(protocol.Header{ID: id, CellID: cellID, ClaimID: claimID}, body)
	if err == nil {
		err = h.SendRaw(ctx, cellID, id, frame)
	}
	if err != nil && created {
		h.mu.Lock()
		if r, ok := h.claims[claimID]; ok && r.state == ClaimAcquiring {
			delete(h.claims, claimID)
		}
		h.mu.Unlock()
	}
	return err
}

// SendUntracked sends a request without recording what it means for the
// claim (a claim.acquire the stub will then not recognise).
func (h *Hub) SendUntracked(ctx context.Context, cellID, claimID string, body any) error {
	id := hubclient.NewID()
	frame, err := protocol.Encode(protocol.Header{ID: id, CellID: cellID, ClaimID: claimID}, body)
	if err != nil {
		return err
	}
	return h.SendRaw(ctx, cellID, id, frame)
}

// Forget drops what the stub knows of a claim (a hub that stopped waiting).
func (h *Hub) Forget(claimID string) {
	h.mu.Lock()
	delete(h.claims, claimID)
	h.mu.Unlock()
}

// SendEgressPolicy sends egress.policy: the claim's extra allowlist, which
// replaces the previous one.
func (h *Hub) SendEgressPolicy(ctx context.Context, cellID, claimID string, allow []string) error {
	if allow == nil {
		allow = []string{}
	}
	return h.Send(ctx, cellID, claimID, &protocol.EgressPolicyBody{Allow: allow, IssuedAt: time.Now().UTC().Format(time.RFC3339Nano)})
}

// WaitReady returns the claim's claim.ready, or an error if the cell sent
// claim.failed first.
func (h *Hub) WaitReady(ctx context.Context, claimID string) (*protocol.ClaimReadyBody, error) {
	e, err := h.WaitSettled(ctx, claimID)
	if err != nil {
		return nil, err
	}
	if f, ok := e.Body.(*protocol.ClaimFailedBody); ok {
		return nil, fmt.Errorf("claim %s failed: %s %s: %s", claimID, f.Kind, f.Signature, f.Reason)
	}
	return e.Body.(*protocol.ClaimReadyBody), nil
}

// WaitSettled returns the next claim.ready or claim.failed of the claim.
func (h *Hub) WaitSettled(ctx context.Context, claimID string) (Event, error) {
	return h.WaitFor(ctx, func(e Event) bool {
		switch e.Body.(type) {
		case *protocol.ClaimReadyBody, *protocol.ClaimFailedBody:
			return e.ClaimID == claimID
		}
		return false
	})
}

func (s *session) remember(step, claim string) {
	s.smu.Lock()
	s.steps[step] = claim
	s.smu.Unlock()
}

// SendRaw writes an arbitrary frame (for fuzzing) and waits for the answer
// to id. An empty id waits for nothing.
func (h *Hub) SendRaw(ctx context.Context, cellID, id string, frame []byte) error {
	h.mu.Lock()
	s, ok := h.sessions[cellID]
	ch := make(chan *protocol.Message, 1)
	if id != "" {
		h.pending[id] = ch
	}
	h.mu.Unlock()
	if !ok {
		return fmt.Errorf("hubstub: cell %s not connected", cellID)
	}
	defer func() {
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
	}()
	if err := h.write(ctx, s, frame); err != nil {
		return err
	}
	if id == "" {
		return nil
	}
	select {
	case m := <-ch:
		if n, ok := m.Body.(*protocol.NackBody); ok {
			return &hubclient.NackError{Code: n.Code, Message: n.Message}
		}
		return nil
	case <-time.After(hubclient.AckTimeout):
		return hubclient.ErrAckTimeout
	case <-ctx.Done():
		return ctx.Err()
	}
}

// WaitFor returns the next event that matches. Events it reads and that do
// not match are kept, in order, for the next WaitFor.
func (h *Hub) WaitFor(ctx context.Context, match func(Event) bool) (Event, error) {
	h.heldMu.Lock()
	for i, e := range h.held {
		if match(e) {
			h.held = append(h.held[:i:i], h.held[i+1:]...)
			h.heldMu.Unlock()
			return e, nil
		}
	}
	h.heldMu.Unlock()
	for {
		select {
		case e := <-h.events:
			if match(e) {
				return e, nil
			}
			h.heldMu.Lock()
			if len(h.held) < 1024 {
				h.held = append(h.held, e)
			}
			h.heldMu.Unlock()
		case <-ctx.Done():
			return Event{}, ctx.Err()
		}
	}
}

// Disconnect closes a cell's connection (dead-man tests).
func (h *Hub) Disconnect(cellID string) {
	h.mu.Lock()
	s, ok := h.sessions[cellID]
	delete(h.sessions, cellID)
	h.mu.Unlock()
	if ok {
		_ = s.ws.Close(websocket.StatusGoingAway, "hub stub disconnect")
	}
}
