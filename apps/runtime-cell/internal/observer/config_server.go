package observer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"

	"database/sql"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
)

const (
	ConfigFingerprintHeader = "X-Kodus-Observer-Config"
	ConfigGenerationHeader  = "X-Kodus-Observer-Generation"
	maxConfigBytes          = 64 << 10
)

// Server binds one observer to one claim. A reset may install a newer
// configuration only after the old probes finish and their pools close.
type Server struct {
	CellID string
	NewID  func() string
	Base   Config
	// OpenManagedSQL is an explicit pool factory. nil uses the pinned
	// PostgreSQL connector; it never falls back to Base.OpenSQL.
	OpenManagedSQL func(Target, observerauth.Credential) (*sql.DB, error)

	mu                            sync.RWMutex
	runner                        *Prober
	h                             http.Handler
	claimID, imageID, fingerprint string
	generation                    uint64
	closed                        bool
}

type ClaimConfig struct {
	ClaimID    string   `json:"claimId,omitempty"`
	ImageID    string   `json:"imageId"`
	Targets    []Target `json:"targets"`
	Generation uint64   `json:"generation,omitempty"`
	// SQL is private cell-to-observer configuration, never a hub frame.
	SQL []observerauth.Credential `json:"sql,omitempty"`
}

// ConfigFingerprint canonicalizes the complete configuration, including
// private authentication, without returning that authentication to a caller.
func ConfigFingerprint(cc ClaimConfig) (string, error) {
	if err := validateClaimConfig(cc); err != nil {
		return "", err
	}
	cc.Targets = slices.Clone(cc.Targets)
	cc.SQL = slices.Clone(cc.SQL)
	slices.SortFunc(cc.Targets, func(a, b Target) int {
		return strings.Compare(targetKey(a.Service, a.Port), targetKey(b.Service, b.Port))
	})
	slices.SortFunc(cc.SQL, func(a, b observerauth.Credential) int {
		return strings.Compare(targetKey(a.Service, a.Port), targetKey(b.Service, b.Port))
	})
	raw, err := json.Marshal(cc)
	if err != nil {
		return "", errors.New("observer: invalid configuration")
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func targetKey(service string, port int) string { return service + "/" + strconv.Itoa(port) }

func validateClaimConfig(cc ClaimConfig) error {
	bad := errors.New("observer: invalid configuration")
	if cc.ImageID == "" || len(cc.ImageID) > 512 || len(cc.ClaimID) > 128 || len(cc.Targets) > 32 || len(cc.SQL) > 32 || (cc.Generation > 0 && cc.ClaimID == "") || (len(cc.SQL) > 0 && cc.Generation == 0) {
		return bad
	}
	for _, value := range []string{cc.ImageID, cc.ClaimID} {
		for _, r := range value {
			if r < 33 || r > 126 {
				return bad
			}
		}
	}
	targets := map[string]Target{}
	for _, t := range cc.Targets {
		if t.Service == "" || len(t.Service) > 63 || t.Port < 1 || t.Port > 65535 {
			return bad
		}
		switch t.Kind {
		case "http", "postgres", "mysql", "grpc":
		default:
			return bad
		}
		host, port, err := net.SplitHostPort(t.Address)
		n, parseErr := strconv.Atoi(port)
		if err != nil || parseErr != nil || n < 1 || n > 65535 || host == "" || len(t.Address) > 320 {
			return bad
		}
		key := targetKey(t.Service, t.Port)
		if _, exists := targets[key]; exists {
			return bad
		}
		targets[key] = t
	}
	used := map[string]bool{}
	for _, c := range cc.SQL {
		if c.Validate() != nil {
			return bad
		}
		key := targetKey(c.Service, c.Port)
		t, ok := targets[key]
		if !ok || t.Kind != "postgres" || used[key] {
			return bad
		}
		host, _, _ := net.SplitHostPort(t.Address)
		if net.ParseIP(host) == nil {
			return bad
		}
		used[key] = true
	}
	return nil
}

// Close waits for in-flight handlers and closes their SQL pools.
func (s *Server) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	s.h = nil
	if s.runner == nil {
		return nil
	}
	err := s.runner.Close()
	s.runner = nil
	return err
}

func (s *Server) configHeaders(w http.ResponseWriter) {
	if s.fingerprint != "" {
		w.Header().Set(ConfigFingerprintHeader, s.fingerprint)
		w.Header().Set(ConfigGenerationHeader, strconv.FormatUint(s.generation, 10))
	}
	w.Header().Set("Cache-Control", "no-store")
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /v1/config", func(w http.ResponseWriter, r *http.Request) {
		cc, err := decodeClaimConfig(r.Body)
		if err != nil {
			http.Error(w, "bad config", http.StatusBadRequest)
			return
		}
		fingerprint, err := ConfigFingerprint(cc)
		if err != nil {
			http.Error(w, "bad config", http.StatusBadRequest)
			return
		}
		// Validate the production connector before reporting readiness. An
		// invalid observer environment is infrastructure failure, not an app fact.
		if len(cc.SQL) > 0 && s.OpenManagedSQL == nil {
			for _, credential := range cc.SQL {
				for _, target := range cc.Targets {
					if target.Service == credential.Service && target.Port == credential.Port {
						if _, err := ManagedPostgresConfig(target, credential); err != nil {
							http.Error(w, "managed SQL configuration unavailable", http.StatusServiceUnavailable)
							return
						}
					}
				}
			}
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		s.configHeaders(w)
		if s.closed {
			http.Error(w, "observer closed", http.StatusServiceUnavailable)
			return
		}
		if s.runner != nil {
			if cc.ClaimID != s.claimID || cc.ImageID != s.imageID || cc.Generation < s.generation || (cc.Generation == s.generation && (cc.Generation == 0 || fingerprint != s.fingerprint)) {
				http.Error(w, "configuration conflict", http.StatusConflict)
				return
			}
			if cc.Generation == s.generation {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			if err := s.runner.Close(); err != nil {
				http.Error(w, "pool cleanup failed", http.StatusServiceUnavailable)
				return
			}
		}
		cfg := s.Base
		cfg.ImageID, cfg.Targets = cc.ImageID, slices.Clone(cc.Targets)
		cfg.ManagedSQL = len(cc.SQL) > 0
		if cfg.ManagedSQL {
			auth := make(map[string]observerauth.Credential, len(cc.SQL))
			for _, c := range cc.SQL {
				auth[targetKey(c.Service, c.Port)] = c
			}
			open := s.OpenManagedSQL
			if open == nil {
				open = OpenManagedPostgres
			}
			cfg.OpenSQL = func(t Target) (*sql.DB, error) {
				c, ok := auth[targetKey(t.Service, t.Port)]
				if !ok || t.Kind != "postgres" {
					return nil, errors.New("observer: SQL target has no managed credential")
				}
				return open(t, c)
			}
		}
		s.runner = New(cfg)
		s.h = handlerFor(s.runner, s.CellID, cc.ClaimID, s.NewID)
		s.claimID, s.imageID, s.generation, s.fingerprint = cc.ClaimID, cc.ImageID, cc.Generation, fingerprint
		s.configHeaders(w)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		s.mu.RLock()
		defer s.mu.RUnlock()
		if s.h == nil {
			http.Error(w, "not configured", http.StatusServiceUnavailable)
			return
		}
		s.h.ServeHTTP(w, r)
	})
	return mux
}

func decodeClaimConfig(body io.Reader) (ClaimConfig, error) {
	var cc ClaimConfig
	raw, err := io.ReadAll(io.LimitReader(body, maxConfigBytes+1))
	if err != nil || len(raw) > maxConfigBytes {
		return cc, errors.New("observer: invalid configuration")
	}
	check := json.NewDecoder(bytes.NewReader(raw))
	if err := checkConfigValue(check, 0); err != nil {
		return cc, err
	}
	if _, err := check.Token(); err != io.EOF {
		return cc, errors.New("observer: trailing configuration")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cc); err != nil {
		return cc, errors.New("observer: invalid configuration")
	}
	return cc, nil
}

func checkConfigValue(dec *json.Decoder, depth int) error {
	if depth > 8 {
		return errors.New("observer: configuration too deep")
	}
	token, err := dec.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		keys := map[string]bool{}
		for dec.More() {
			token, err := dec.Token()
			if err != nil {
				return err
			}
			key, ok := token.(string)
			if !ok {
				return errors.New("observer: invalid key")
			}
			for _, r := range key {
				if r < 32 || r > 126 {
					return errors.New("observer: invalid key")
				}
			}
			folded := strings.ToLower(key)
			if keys[folded] || folded == "__proto__" {
				return errors.New("observer: duplicate key")
			}
			keys[folded] = true
			if err := checkConfigValue(dec, depth+1); err != nil {
				return err
			}
		}
		token, err = dec.Token()
		if err != nil || token != json.Delim('}') {
			return errors.New("observer: invalid object")
		}
	case '[':
		for dec.More() {
			if err := checkConfigValue(dec, depth+1); err != nil {
				return err
			}
		}
		token, err = dec.Token()
		if err != nil || token != json.Delim(']') {
			return errors.New("observer: invalid array")
		}
	default:
		return errors.New("observer: invalid delimiter")
	}
	return nil
}
