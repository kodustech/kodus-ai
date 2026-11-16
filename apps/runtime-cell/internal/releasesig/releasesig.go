// Package releasesig signs and verifies a cell release's binaries offline
// (S-17 (a), docs/runtime/isolation-p3-snapshots.md): the release's
// SHA256SUMS, bound to the release's name, signed with an ed25519 key whose
// public half is pinned where the release is installed. Only the standard
// library's crypto/ed25519 and crypto/sha256 are used.
//
// A release directory holds
//
//	SHA256SUMS       sha256sum's output: "<64 hex>  <file>" per line
//	SHA256SUMS.sig   the signature (Signature), text
//	<file>...        the files SHA256SUMS lists
//
// What is signed is Message(release, SHA256SUMS): a fixed prefix, the
// release's name and the manifest's bytes. The name inside the signature
// stops a validly signed older release from being installed as a newer one,
// as minisign's trusted comment does; the prefix keeps the key from signing
// anything else that could pass for a release.
package releasesig

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	// ManifestName is the release's checksum list.
	ManifestName = "SHA256SUMS"
	// SignatureName is the manifest's signature.
	SignatureName = ManifestName + ".sig"

	signatureHeader  = "kodus-cell-release-signature v1"
	messagePrefix    = "kodus-cell-release v1\n"
	publicKeyPrefix  = "kodus-cell-release-key "
	privateKeyPrefix = "kodus-cell-release-private-key "

	// maxManifest bounds the manifest and the signature files.
	maxManifest = 1 << 20
)

var (
	releaseName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$`)
	manifestLine = regexp.MustCompile(`^([0-9a-f]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._+-]{0,127})$`)
)

// Error is a refused release: File is the file that failed (empty when
// nothing was read), Reason why.
type Error struct {
	File   string
	Reason string
}

func (e *Error) Error() string {
	if e.File == "" {
		return "release refused: " + e.Reason
	}
	return "release refused: " + e.File + ": " + e.Reason
}

func refuse(file, format string, a ...any) error {
	return &Error{File: file, Reason: fmt.Sprintf(format, a...)}
}

// PublicKey is a pinned release key and its id.
type PublicKey struct {
	ID  string
	Key ed25519.PublicKey
}

// KeyID names a public key: the first 8 bytes of its SHA-256, in hex.
func KeyID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

// FormatPublicKey is pub as one line of a pinned key file.
func FormatPublicKey(pub ed25519.PublicKey) string {
	return publicKeyPrefix + base64.StdEncoding.EncodeToString(pub) + "\n"
}

// ParsePublicKeys reads a pinned key file: one FormatPublicKey line per
// key, '#' comments and blank lines ignored. Several keys let a new one be
// pinned before the release tooling signs with it.
func ParsePublicKeys(text []byte) ([]PublicKey, error) {
	var keys []PublicKey
	for i, line := range strings.Split(string(text), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		raw, ok := strings.CutPrefix(line, publicKeyPrefix)
		if !ok {
			return nil, fmt.Errorf("releasesig: line %d is not a %q line", i+1, strings.TrimSpace(publicKeyPrefix))
		}
		b, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || len(b) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("releasesig: line %d is not an ed25519 public key", i+1)
		}
		keys = append(keys, PublicKey{ID: KeyID(b), Key: b})
	}
	return keys, nil
}

// FormatPrivateKey is the private key file the release tooling reads: the
// key's seed, base64. It is never committed: a test makes its own.
func FormatPrivateKey(priv ed25519.PrivateKey) string {
	return privateKeyPrefix + base64.StdEncoding.EncodeToString(priv.Seed()) + "\n"
}

// ParsePrivateKey reads FormatPrivateKey's output.
func ParsePrivateKey(text []byte) (ed25519.PrivateKey, error) {
	raw, ok := strings.CutPrefix(strings.TrimSpace(string(text)), privateKeyPrefix)
	if !ok {
		return nil, errors.New("releasesig: not a release private key file")
	}
	seed, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("releasesig: not an ed25519 key seed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// Message is what a release's signature covers.
func Message(release string, manifest []byte) []byte {
	m := make([]byte, 0, len(messagePrefix)+len(release)+len(manifest)+16)
	m = append(m, messagePrefix...)
	m = append(m, "release "+release+"\n"...)
	return append(m, manifest...)
}

// Sign is the signature file of manifest for release.
func Sign(priv ed25519.PrivateKey, release string, manifest []byte) ([]byte, error) {
	if !releaseName.MatchString(release) {
		return nil, fmt.Errorf("releasesig: %q is not a release name", release)
	}
	if _, err := ParseManifest(manifest, ManifestName); err != nil {
		return nil, err
	}
	pub, _ := priv.Public().(ed25519.PublicKey)
	sig := ed25519.Sign(priv, Message(release, manifest))
	var b bytes.Buffer
	fmt.Fprintf(&b, "%s\nkey %s\nrelease %s\nsignature %s\n", signatureHeader, KeyID(pub), release, base64.StdEncoding.EncodeToString(sig))
	return b.Bytes(), nil
}

// ParseManifest reads a SHA256SUMS: file name to its sha256, in hex. file
// names the manifest in an error.
func ParseManifest(text []byte, file string) (map[string]string, error) {
	out := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(text))
	n := 0
	for sc.Scan() {
		n++
		line := sc.Text()
		if line == "" {
			continue
		}
		m := manifestLine.FindStringSubmatch(line)
		if m == nil {
			return nil, refuse(file, "line %d is not \"<sha256>  <file>\"", n)
		}
		if _, dup := out[m[2]]; dup {
			return nil, refuse(file, "%s is listed twice", m[2])
		}
		out[m[2]] = m[1]
	}
	if err := sc.Err(); err != nil {
		return nil, refuse(file, "%v", err)
	}
	if len(out) == 0 {
		return nil, refuse(file, "lists no file")
	}
	return out, nil
}

// Verify checks dir's signature against the pinned keys and returns its
// manifest: refused when no key is pinned, when SHA256SUMS or its
// signature is missing or malformed, when the signature names another
// release or a key that is not pinned, or does not verify. It reads no
// listed file: CheckFile does, as each is installed.
func Verify(dir, release string, keys []PublicKey) (map[string]string, error) {
	if len(keys) == 0 {
		return nil, refuse("", "no release key is pinned: nothing can be verified")
	}
	manifestPath, sigPath := filepath.Join(dir, ManifestName), filepath.Join(dir, SignatureName)
	manifest, err := readSmall(manifestPath)
	if err != nil {
		return nil, err
	}
	sigText, err := readSmall(sigPath)
	if err != nil {
		return nil, err
	}
	keyID, signedRelease, sig, err := parseSignature(sigText, sigPath)
	if err != nil {
		return nil, err
	}
	// Only the name is bound here: an older release asked by its own name
	// verifies. Ordering against the installed release is cellupdate's.
	if signedRelease != release {
		return nil, refuse(sigPath, "signed for release %q, not %q", signedRelease, release)
	}
	var pub ed25519.PublicKey
	for _, k := range keys {
		if k.ID == keyID {
			pub = k.Key
		}
	}
	if pub == nil {
		return nil, refuse(sigPath, "signed with key %s, which is not pinned", keyID)
	}
	if !ed25519.Verify(pub, Message(release, manifest), sig) {
		return nil, refuse(sigPath, "the signature does not verify against %s with key %s", ManifestName, keyID)
	}
	return ParseManifest(manifest, manifestPath)
}

func parseSignature(text []byte, file string) (keyID, release string, sig []byte, err error) {
	lines := strings.Split(strings.TrimRight(string(text), "\n"), "\n")
	if len(lines) != 4 || lines[0] != signatureHeader {
		return "", "", nil, refuse(file, "not a %q file", signatureHeader)
	}
	fields := map[string]string{}
	for _, l := range lines[1:] {
		k, v, ok := strings.Cut(l, " ")
		if !ok {
			return "", "", nil, refuse(file, "malformed line %q", l)
		}
		fields[k] = v
	}
	keyID, release = fields["key"], fields["release"]
	if len(keyID) != 16 || !releaseName.MatchString(release) {
		return "", "", nil, refuse(file, "malformed key or release line")
	}
	sig, err = base64.StdEncoding.DecodeString(fields["signature"])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return "", "", nil, refuse(file, "malformed signature line")
	}
	return keyID, release, sig, nil
}

func readSmall(path string) ([]byte, error) {
	f, err := os.Open(path) //nolint:gosec // G304: a file of the release directory the operator named
	if errors.Is(err, os.ErrNotExist) {
		return nil, refuse(path, "missing: the release is not signed")
	}
	if err != nil {
		return nil, refuse(path, "%v", err)
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, maxManifest+1))
	if err != nil {
		return nil, refuse(path, "%v", err)
	}
	if len(b) > maxManifest {
		return nil, refuse(path, "larger than %d bytes", maxManifest)
	}
	return b, nil
}

// CopyChecked copies src to dst (created with mode, never replaced) and
// refuses, naming src, when its bytes are not the manifest's sha256: the
// hash is of the bytes written, so a file swapped after Verify is caught.
func CopyChecked(src, dst, want string, mode os.FileMode) error {
	in, err := os.Open(src) //nolint:gosec // G304: a file the verified manifest lists
	if err != nil {
		return refuse(src, "%v", err)
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode) //nolint:gosec // G304: the staging directory the updater made
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(out, h), in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return refuse(src, "%v", err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return refuse(src, "sha256 %s, not the signed %s", got, want)
	}
	return nil
}

// CheckFile refuses, naming path, a file whose sha256 is not want.
func CheckFile(path, want string) error {
	f, err := os.Open(path) //nolint:gosec // G304: a file of an installed release
	if err != nil {
		return refuse(path, "%v", err)
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return refuse(path, "%v", err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return refuse(path, "sha256 %s, not the signed %s", got, want)
	}
	return nil
}
