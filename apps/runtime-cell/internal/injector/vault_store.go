package injector

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	vaultFormat         = 1
	externalVaultFormat = 2
	maxVaultBytes       = 4 << 20
	maxVaultPlainBytes  = 2 << 20
	maxVaultVersions    = 256
	maxVaultBindings    = 1024
	maxVaultClaims      = 512
	maxVaultValue       = 8192
)

type versionRecord struct {
	SecretVersion
	Revoked  bool `json:"revoked"`
	External bool `json:"external,omitempty"`
}
type claimRecord struct {
	Scope     ClaimScope `json:"scope"`
	ExpiresAt time.Time  `json:"expiresAt"`
	Revoked   bool       `json:"revoked"`
}

// bindingFence exists only while a claim has an authority lookup in flight.
// A signed removal invalidates those lookups without retaining unknown IDs.
type bindingFence struct {
	pending int
	revoked bool
}
type vaultState struct {
	Version          int                      `json:"version"`
	CellID           string                   `json:"cellId"`
	ExternalSourceID string                   `json:"externalSourceId,omitempty"`
	Versions         map[string]versionRecord `json:"versions"`
	Bindings         map[string]Binding       `json:"bindings"`
	Claims           map[string]claimRecord   `json:"claims"`
}
type vaultEnvelope struct {
	Version    int    `json:"version"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

// EncryptedVault encrypts the complete state, including metadata and grants.
// A post-rename durability error poisons admission until Close/Open recovery;
// potentially committed records are never rolled back or removed in memory.
type EncryptedVault struct {
	root                *os.Root
	lock                *os.File
	aead                cipher.AEAD
	cellID              string
	format              int
	externalValues      SecretVersionReader
	externalSourceID    string
	claims              ClaimAuthorizer
	now                 func() time.Time
	gate                chan struct{}
	state               vaultState
	closed, unavailable bool
	syncDir             func() error
	once                sync.Once
	closeErr            error
	binds               map[string]*bindingFence
	activeBinds         int
}

func OpenConfiguredVault(cfg VaultConfig) (ManagedVault, error) {
	if (cfg.ExternalValues == nil) != (cfg.ExternalSourceID == "") || (cfg.ExternalSourceID != "" && !vaultID.MatchString(cfg.ExternalSourceID)) {
		return nil, ErrVaultConfig
	}
	if cfg.Directory == "" && cfg.KeyFile == "" && cfg.CellID == "" {
		if cfg.ExternalValues != nil {
			return nil, ErrVaultConfig
		}
		return RefusingVault{}, nil
	}
	if cfg.Directory == "" || cfg.KeyFile == "" || !vaultID.MatchString(cfg.CellID) {
		return nil, ErrVaultConfig
	}
	ctx := cfg.Context
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for _, p := range []string{cfg.Directory, cfg.KeyFile} {
		absolute, err := filepath.Abs(p)
		if err != nil || absolute != filepath.Clean(p) {
			return nil, ErrVaultConfig
		}
		resolved, err := filepath.EvalSymlinks(p)
		if err != nil || resolved != p {
			return nil, ErrVaultConfig
		}
	}
	relative, err := filepath.Rel(cfg.Directory, cfg.KeyFile)
	if err != nil || filepath.IsLocal(relative) {
		return nil, ErrVaultConfig
	}
	st, err := os.Lstat(cfg.Directory)
	if err != nil || !st.IsDir() || !privateInfo(st, 0700) {
		return nil, ErrVaultConfig
	}
	keyFile, err := os.OpenFile(cfg.KeyFile, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, ErrVaultConfig
	}
	info, err := keyFile.Stat()
	if err != nil || !info.Mode().IsRegular() || !privateInfo(info, 0600) || info.Size() != 32 {
		keyFile.Close()
		return nil, ErrVaultConfig
	}
	keyInfo := info
	key, err := io.ReadAll(io.LimitReader(keyFile, 33))
	keyFile.Close()
	defer clear(key)
	if err != nil || len(key) != 32 {
		return nil, ErrVaultConfig
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrVaultConfig
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrVaultConfig
	}
	root, err := os.OpenRoot(cfg.Directory)
	if err != nil {
		return nil, ErrVaultConfig
	}
	lock, err := root.OpenFile("lock", os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if err != nil {
		root.Close()
		return nil, ErrVaultConfig
	}
	fail := func(e error) (ManagedVault, error) { lock.Close(); root.Close(); return nil, e }
	info, err = lock.Stat()
	if err != nil || !info.Mode().IsRegular() || !privateInfo(info, 0600) || os.SameFile(keyInfo, info) {
		return fail(ErrVaultConfig)
	}
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fail(ErrVaultUnavailable)
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	format := vaultFormat
	if cfg.ExternalValues != nil {
		format = externalVaultFormat
	}
	v := &EncryptedVault{root: root, lock: lock, aead: aead, cellID: cfg.CellID, format: format, externalValues: cfg.ExternalValues, externalSourceID: cfg.ExternalSourceID, claims: cfg.Claims, now: now, gate: make(chan struct{}, 1), state: vaultState{Version: format, CellID: cfg.CellID, ExternalSourceID: cfg.ExternalSourceID, Versions: map[string]versionRecord{}, Bindings: map[string]Binding{}, Claims: map[string]claimRecord{}}}
	v.syncDir = func() error {
		f, err := root.Open(".")
		if err != nil {
			return err
		}
		defer f.Close()
		return f.Sync()
	}
	if err = v.load(ctx, keyInfo); err != nil {
		return fail(err)
	}
	return v, nil
}

func privateInfo(st os.FileInfo, mode os.FileMode) bool {
	sys, ok := st.Sys().(*syscall.Stat_t)
	return ok && sys.Uid == uint32(os.Geteuid()) && (st.IsDir() || sys.Nlink == 1) && st.Mode().Perm() == mode
}

func (v *EncryptedVault) load(ctx context.Context, keyInfo os.FileInfo) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f, err := v.root.OpenFile("vault.json", os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err == nil {
		info, e := f.Stat()
		if e != nil || !info.Mode().IsRegular() || !privateInfo(info, 0600) || info.Size() > maxVaultBytes || os.SameFile(keyInfo, info) {
			f.Close()
			return ErrVaultConfig
		}
		raw, e := io.ReadAll(io.LimitReader(f, maxVaultBytes+1))
		f.Close()
		if e != nil || len(raw) > maxVaultBytes {
			return ErrVaultUnavailable
		}
		var env vaultEnvelope
		if canonicalDecode(raw, &env) != nil || env.Version != v.format {
			return ErrVaultConfig
		}
		nonce, e := base64.RawStdEncoding.DecodeString(env.Nonce)
		if e != nil || len(nonce) != v.aead.NonceSize() {
			return ErrVaultConfig
		}
		encrypted, e := base64.RawStdEncoding.DecodeString(env.Ciphertext)
		if e != nil || len(encrypted) > maxVaultPlainBytes+v.aead.Overhead() {
			return ErrVaultConfig
		}
		plain, e := v.aead.Open(nil, nonce, encrypted, v.aad())
		if e != nil {
			return ErrVaultConfig
		}
		defer clear(plain)
		if len(plain) > maxVaultPlainBytes || canonicalDecode(plain, &v.state) != nil || !v.validState() {
			return ErrVaultConfig
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrVaultConfig
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	dir, err := v.root.Open(".")
	if err != nil {
		return ErrVaultUnavailable
	}
	defer dir.Close()
	// Bounded startup cleanup only touches our fixed encrypted temporary files,
	// under the exclusive lock. Unknown files and unsafe entries refuse startup.
	entries, err := dir.ReadDir(130)
	if err != nil && !errors.Is(err, io.EOF) {
		return ErrVaultUnavailable
	}
	if len(entries) > 128 {
		return ErrVaultCapacity
	}
	pending := []string{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := v.root.Lstat(entry.Name())
		// File identity, not lexical containment, protects keys on case-insensitive
		// filesystems and bind aliases. Validate the entire layout before deleting.
		if err != nil || os.SameFile(keyInfo, info) {
			return ErrVaultConfig
		}
		if entry.Name() == "lock" || entry.Name() == "vault.json" {
			continue
		}
		if !validPendingName(entry.Name()) || !info.Mode().IsRegular() || !privateInfo(info, 0600) || info.Size() > maxVaultBytes {
			return ErrVaultConfig
		}
		pending = append(pending, entry.Name())
	}
	for _, name := range pending {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := v.root.Lstat(name)
		if err != nil || os.SameFile(keyInfo, info) || !info.Mode().IsRegular() || !privateInfo(info, 0600) {
			return ErrVaultConfig
		}
		if err = v.root.Remove(name); err != nil {
			return ErrVaultUnavailable
		}
	}
	return nil
}
func canonicalDecode(raw []byte, out any) error {
	if err := json.Unmarshal(raw, out); err != nil {
		return ErrVaultConfig
	}
	encoded, err := json.Marshal(out)
	if err != nil || !bytes.Equal(raw, encoded) {
		return ErrVaultConfig
	}
	return nil
}
func validPendingName(s string) bool {
	if len(s) != len("pending-")+24 || s[:8] != "pending-" {
		return false
	}
	b, e := hex.DecodeString(s[8:])
	return e == nil && len(b) == 12 && hex.EncodeToString(b) == s[8:]
}
func (v *EncryptedVault) aad() []byte {
	return []byte("kodus-runtime/injector-vault/v" + strconv.Itoa(v.format) + "\x00" + v.cellID)
}
func versionKey(s SecretScope, id string, n uint64) string {
	return s.OrganizationID + "|" + s.EnvironmentID + "|" + id + "|" + strconv.FormatUint(n, 10)
}
func bindingKey(claim, host string) string { return claim + "|" + host }
func (v *EncryptedVault) enter(ctx context.Context) error {
	select {
	case v.gate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		v.leave()
		return err
	}
	if v.closed || v.unavailable {
		v.leave()
		return ErrVaultUnavailable
	}
	return nil
}
func (v *EncryptedVault) leave() { <-v.gate }
func (v *EncryptedVault) clone() vaultState {
	return vaultState{Version: v.state.Version, CellID: v.state.CellID, ExternalSourceID: v.state.ExternalSourceID, Versions: maps.Clone(v.state.Versions), Bindings: maps.Clone(v.state.Bindings), Claims: maps.Clone(v.state.Claims)}
}

// Expired claim authorities cannot authorize a replay, so their grants and
// revocation tombstones no longer need storage. Live revocations never vanish.
func (v *EncryptedVault) pruneClaims(next *vaultState) {
	now := v.now()
	for id, c := range next.Claims {
		if !now.Before(c.ExpiresAt) {
			delete(next.Claims, id)
		}
	}
	for key, b := range next.Bindings {
		if _, ok := next.Claims[b.Scope.ClaimID]; !ok || !now.Before(b.ExpiresAt) {
			delete(next.Bindings, key)
		}
	}
}

func (v *EncryptedVault) save(ctx context.Context, next vaultState) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	plain, err := json.Marshal(next)
	if err != nil || len(plain) > maxVaultPlainBytes {
		return ErrVaultCapacity
	}
	defer clear(plain)
	nonce := make([]byte, v.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return ErrVaultUnavailable
	}
	raw, err := json.Marshal(vaultEnvelope{Version: v.format, Nonce: base64.RawStdEncoding.EncodeToString(nonce), Ciphertext: base64.RawStdEncoding.EncodeToString(v.aead.Seal(nil, nonce, plain, v.aad()))})
	if err != nil || len(raw) > maxVaultBytes {
		return ErrVaultCapacity
	}
	var random [12]byte
	if _, err = rand.Read(random[:]); err != nil {
		return ErrVaultUnavailable
	}
	name := "pending-" + hex.EncodeToString(random[:])
	f, err := v.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return ErrVaultUnavailable
	}
	renamed := false
	defer func() {
		f.Close()
		if !renamed {
			_ = v.root.Remove(name)
		}
	}()
	if _, err = f.Write(raw); err != nil {
		return ErrVaultUnavailable
	}
	if err = f.Sync(); err != nil {
		return ErrVaultUnavailable
	}
	if err = f.Close(); err != nil {
		return ErrVaultUnavailable
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = v.root.Rename(name, "vault.json"); err != nil {
		return ErrVaultUnavailable
	}
	renamed = true
	v.state = next
	if err = v.syncDir(); err != nil {
		v.unavailable = true
		return ErrVaultUnavailable
	}
	return nil
}
func (v *EncryptedVault) Close() error {
	v.once.Do(func() {
		v.gate <- struct{}{}
		defer v.leave()
		v.closed = true
		v.state = vaultState{}
		v.binds = nil
		v.activeBinds = 0
		v.closeErr = errors.Join(v.lock.Close(), v.root.Close())
	})
	return v.closeErr
}
