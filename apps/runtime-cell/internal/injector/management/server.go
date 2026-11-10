package management

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

// Serve owns only the explicitly configured socket's lifetime. Nothing listens
// until called; it never creates directories or opens the vault itself.
func Serve(ctx context.Context, socketPath string, vault VaultAdmin, log *slog.Logger) error {
	return serve(ctx, socketPath, vault, log, nil)
}
func serve(ctx context.Context, path string, v VaultAdmin, log *slog.Logger, ready chan<- struct{}) error {
	if ctx.Err() != nil {
		return failure("cancelled", 408)
	}
	if v == nil {
		return failure("unavailable", 503)
	}
	l, e := listenPrivate(path)
	if e != nil {
		return e
	}
	defer l.Close()
	handler := &handler{vault: v, slots: make(chan struct{}, 4), log: log}
	s := &http.Server{Handler: handler, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 1024, BaseContext: func(net.Listener) context.Context { return ctx }, ErrorLog: slog.NewLogLogger(slog.NewTextHandler(io.Discard, nil), slog.LevelError)}
	stopped := make(chan struct{})
	defer close(stopped)
	go func() {
		select {
		case <-ctx.Done():
			_ = s.Close()
		case <-stopped:
		}
	}()
	if ready != nil {
		close(ready)
	}
	if log != nil {
		log.Info("vault.management.started")
	}
	e = s.Serve(l)
	if log != nil {
		log.Info("vault.management.stopped")
	}
	if ctx.Err() != nil || errors.Is(e, http.ErrServerClosed) {
		return nil
	}
	return failure("unavailable", 503)
}

type handler struct {
	vault VaultAdmin
	slots chan struct{}
	log   *slog.Logger
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	operation := "unknown"
	response := &responseWriter{ResponseWriter: w, code: "ok"}
	w = response
	defer func() {
		if h.log != nil {
			h.log.Info("vault.management.request", "operation", operation, "code", response.code, "status", response.status, "duration_ms", time.Since(started).Milliseconds())
		}
	}()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodPost {
		writeFailure(w, failure("method_not_allowed", 405))
		return
	}
	candidate := strings.TrimPrefix(r.URL.Path, "/v1/vault/")
	if r.URL.Path != "/v1/vault/"+candidate || r.URL.RawQuery != "" || r.URL.RawPath != "" {
		writeFailure(w, failure("invalid_operation", 404))
		return
	}
	if _, ok := fields[candidate]; !ok {
		writeFailure(w, failure("invalid_operation", 404))
		return
	}
	operation = candidate
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		writeFailure(w, failure("invalid_request", 400))
		return
	}
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		writeFailure(w, failure("busy", 503))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	raw, e := io.ReadAll(r.Body)
	defer clear(raw)
	if e != nil {
		var large *http.MaxBytesError
		if errors.As(e, &large) {
			writeFailure(w, failure("too_large", 413))
		} else {
			writeFailure(w, failure("invalid_request", 400))
		}
		return
	}
	req, e := parseRequest(operation, raw)
	if e != nil {
		writeFailure(w, e)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var output []byte
	switch operation {
	case "put":
		e = h.vault.PutVersion(ctx, injector.SecretVersion{Scope: req.scope(), ID: req.id, Version: req.version, Value: req.value, ExpiresAt: req.expires})
	case "register-external":
		// The process configuration pins mode and source. This request carries
		// only immutable version metadata; it neither reads nor grants a value.
		e = h.vault.RegisterExternalVersion(ctx, injector.ExternalSecretVersion{Scope: req.scope(), ID: req.id, Version: req.version, ExpiresAt: req.expires})
	case "bind":
		e = h.vault.Bind(ctx, injector.Binding{Scope: req.claimScope(), SecretID: req.secretID, Version: req.version, Host: req.host, Header: req.header, ExpiresAt: req.expires})
	case "revoke-version":
		e = h.vault.RevokeVersion(ctx, req.scope(), req.id, req.version)
	case "revoke-claim":
		e = h.vault.RevokeClaim(ctx, req.claimScope())
	case "list":
		var rows []injector.SecretVersionInfo
		rows, e = h.vault.ListVersions(ctx, req.scope())
		if e == nil {
			if len(rows) > 256 {
				e = failure("capacity", 503)
				break
			}
			list := make([]VersionInfo, 0, len(rows))
			for _, x := range rows {
				list = append(list, VersionInfo{OrganizationID: x.Scope.OrganizationID, EnvironmentID: x.Scope.EnvironmentID, ID: x.ID, Version: x.Version, ExpiresAt: x.ExpiresAt, Revoked: x.Revoked})
			}
			output, e = json.Marshal(struct {
				Versions []VersionInfo `json:"versions"`
			}{list})
			if e == nil {
				output, e = sanitizeList(output, req.scope())
			}
		}
	}
	if e != nil {
		writeFailure(w, vaultFailure(e))
		return
	}
	if operation == "list" {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(output)
	} else {
		w.WriteHeader(http.StatusNoContent)
	}
}
func vaultFailure(e error) error {
	var typed *Error
	if errors.As(e, &typed) {
		return typed
	}
	switch {
	case errors.Is(e, injector.ErrVaultConfig):
		return failure("invalid_request", 400)
	case errors.Is(e, injector.ErrVaultDenied):
		return failure("denied", 403)
	case errors.Is(e, injector.ErrVaultConflict):
		return failure("conflict", 409)
	case errors.Is(e, injector.ErrVaultCapacity):
		return failure("capacity", 503)
	case errors.Is(e, context.Canceled), errors.Is(e, context.DeadlineExceeded):
		return failure("cancelled", 408)
	default:
		return failure("unavailable", 503)
	}
}

type responseWriter struct {
	http.ResponseWriter
	status int
	code   string
}

func (w *responseWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *responseWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}

func writeFailure(w http.ResponseWriter, e error) {
	var typed *Error
	if !errors.As(e, &typed) {
		typed = failure("unavailable", 503)
	}
	typed = safeError(typed)
	if captured, ok := w.(*responseWriter); ok {
		captured.code = typed.Code
	}
	w.WriteHeader(typed.Status)
	_ = json.NewEncoder(w).Encode(struct {
		Code string `json:"code"`
	}{typed.Code})
}

func safeError(e *Error) *Error {
	switch e.Code {
	case "invalid_request":
		return failure(e.Code, 400)
	case "invalid_operation":
		return failure(e.Code, 404)
	case "method_not_allowed":
		return failure(e.Code, 405)
	case "too_large":
		return failure(e.Code, 413)
	case "denied":
		return failure(e.Code, 403)
	case "conflict":
		return failure(e.Code, 409)
	case "cancelled":
		return failure(e.Code, 408)
	case "capacity", "busy", "unsafe_socket", "unavailable":
		return failure(e.Code, 503)
	default:
		return failure("unavailable", 503)
	}
}
