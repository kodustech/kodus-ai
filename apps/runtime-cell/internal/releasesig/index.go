package releasesig

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"time"
)

// The release index is what the release key says about every release at
// once, in the spirit of TUF's timestamp and targets roles, kept to one
// signed file: the latest release, the lowest one still allowed, the keys
// revoked, when it was issued and until when it holds. A cell installs a
// release only under a current index (cellupdate), so
//   - a frozen mirror that keeps serving an old index stops working when it
//     expires (TUF's freeze attack);
//   - a key revoked once stays revoked on that host, even under a later
//     index signed by the thief's key that leaves it out (the host keeps
//     what it saw);
//   - a release below the minimum (a known-bad one) is refused whatever the
//     installed version.
//
// The index is signed with the release key under its own prefix, so a
// release signature can never pass for an index one, nor the reverse.

const (
	// IndexName is the index file, next to a release's SHA256SUMS or on its own.
	IndexName = "RELEASE-INDEX"
	// IndexSignatureName is its signature.
	IndexSignatureName = IndexName + ".sig"

	indexSignatureHeader = "kodus-cell-release-index-signature v1"
	indexMessagePrefix   = "kodus-cell-release-index v1\n"

	// MaxIndexValidity bounds how long one index may hold.
	MaxIndexValidity = 400 * 24 * time.Hour
	// indexClockSkew is how far in the future an index may be issued.
	indexClockSkew = 5 * time.Minute
)

var keyIDPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

// Index is the signed release index.
type Index struct {
	Issued      time.Time `json:"issued"`
	Expires     time.Time `json:"expires"`
	Latest      string    `json:"latest"`
	Minimum     string    `json:"minimum"`
	RevokedKeys []string  `json:"revokedKeys"`
}

// IndexMessage is what an index's signature covers.
func IndexMessage(index []byte) []byte {
	return append([]byte(indexMessagePrefix), index...)
}

// MarshalIndex is the index file's bytes (canonical: fixed field order, revoked keys sorted).
func MarshalIndex(ix Index) ([]byte, error) {
	if err := ix.check(); err != nil {
		return nil, err
	}
	ix.Issued, ix.Expires = ix.Issued.UTC().Truncate(time.Second), ix.Expires.UTC().Truncate(time.Second)
	ix.RevokedKeys = slices.Clone(ix.RevokedKeys)
	slices.Sort(ix.RevokedKeys)
	if ix.RevokedKeys == nil {
		ix.RevokedKeys = []string{}
	}
	b, err := json.MarshalIndent(ix, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// SignIndex is the signature file of an index's bytes.
func SignIndex(priv ed25519.PrivateKey, index []byte) ([]byte, error) {
	ix, err := parseIndex(index, IndexName)
	if err != nil {
		return nil, err
	}
	pub, _ := priv.Public().(ed25519.PublicKey)
	if slices.Contains(ix.RevokedKeys, KeyID(pub)) {
		return nil, fmt.Errorf("releasesig: the index revokes the key that would sign it (%s)", KeyID(pub))
	}
	sig := ed25519.Sign(priv, IndexMessage(index))
	var b bytes.Buffer
	fmt.Fprintf(&b, "%s\nkey %s\nsignature %s\n", indexSignatureHeader, KeyID(pub), base64.StdEncoding.EncodeToString(sig))
	return b.Bytes(), nil
}

// VerifyIndex reads dir's RELEASE-INDEX and its signature and checks them
// against the pinned keys at now: refused when either file is missing or
// malformed, when the signing key is not pinned or is revoked (by the
// index itself or by alsoRevoked, what the host already saw), when the
// signature does not verify, when the index is issued in the future, has
// expired, or holds longer than MaxIndexValidity.
func VerifyIndex(dir string, keys []PublicKey, alsoRevoked []string, now time.Time) (Index, error) {
	if len(keys) == 0 {
		return Index{}, refuse("", "no release key is pinned: nothing can be verified")
	}
	indexPath, sigPath := filepath.Join(dir, IndexName), filepath.Join(dir, IndexSignatureName)
	text, err := readSmall(indexPath)
	if err != nil {
		return Index{}, refuse(indexPath, "missing or unreadable: a release installs only under a signed release index")
	}
	sigText, err := readSmall(sigPath)
	if err != nil {
		return Index{}, refuse(sigPath, "missing or unreadable: the release index is not signed")
	}
	keyID, sig, err := parseIndexSignature(sigText, sigPath)
	if err != nil {
		return Index{}, err
	}
	ix, err := parseIndex(text, indexPath)
	if err != nil {
		return Index{}, err
	}
	if slices.Contains(ix.RevokedKeys, keyID) || slices.Contains(alsoRevoked, keyID) {
		return Index{}, refuse(sigPath, "signed with key %s, which is revoked", keyID)
	}
	var pub ed25519.PublicKey
	for _, k := range keys {
		if k.ID == keyID {
			pub = k.Key
		}
	}
	if pub == nil {
		return Index{}, refuse(sigPath, "signed with key %s, which is not pinned", keyID)
	}
	if !ed25519.Verify(pub, IndexMessage(text), sig) {
		return Index{}, refuse(sigPath, "the signature does not verify against %s with key %s", IndexName, keyID)
	}
	switch {
	case ix.Issued.After(now.Add(indexClockSkew)):
		return Index{}, refuse(indexPath, "issued %s, in the future: check this host's clock", ix.Issued.Format(time.RFC3339))
	case !now.Before(ix.Expires):
		return Index{}, refuse(indexPath, "expired %s: fetch the current release index (a mirror that serves an old one is refused)", ix.Expires.Format(time.RFC3339))
	}
	return ix, nil
}

func (ix Index) check() error {
	switch {
	case ix.Issued.IsZero() || ix.Expires.IsZero():
		return fmt.Errorf("releasesig: the index needs issued and expires")
	case !ix.Expires.After(ix.Issued):
		return fmt.Errorf("releasesig: the index expires before it is issued")
	case ix.Expires.Sub(ix.Issued) > MaxIndexValidity:
		return fmt.Errorf("releasesig: the index holds longer than %s", MaxIndexValidity)
	case !releaseName.MatchString(ix.Latest) || !releaseName.MatchString(ix.Minimum):
		return fmt.Errorf("releasesig: latest and minimum must be release names")
	}
	for _, k := range ix.RevokedKeys {
		if !keyIDPattern.MatchString(k) {
			return fmt.Errorf("releasesig: revoked key %q is not a key id", k)
		}
	}
	return nil
}

func parseIndex(text []byte, file string) (Index, error) {
	var ix Index
	dec := json.NewDecoder(bytes.NewReader(text))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&ix); err != nil {
		return Index{}, refuse(file, "not a release index: %v", err)
	}
	if err := ix.check(); err != nil {
		return Index{}, refuse(file, "%v", err)
	}
	return ix, nil
}

func parseIndexSignature(text []byte, file string) (string, []byte, error) {
	lines := bytes.Split(bytes.TrimRight(text, "\n"), []byte("\n"))
	if len(lines) != 3 || string(lines[0]) != indexSignatureHeader {
		return "", nil, refuse(file, "not a %q file", indexSignatureHeader)
	}
	keyID, ok1 := bytes.CutPrefix(lines[1], []byte("key "))
	b64, ok2 := bytes.CutPrefix(lines[2], []byte("signature "))
	if !ok1 || !ok2 || !keyIDPattern.Match(keyID) {
		return "", nil, refuse(file, "malformed key or signature line")
	}
	sig, err := base64.StdEncoding.DecodeString(string(b64))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return "", nil, refuse(file, "malformed signature line")
	}
	return string(keyID), sig, nil
}

// signIndexFile writes dir's RELEASE-INDEX and its signature; neither may exist.
func signIndexFile(priv ed25519.PrivateKey, dir string, ix Index) error {
	text, err := MarshalIndex(ix)
	if err != nil {
		return err
	}
	sig, err := SignIndex(priv, text)
	if err != nil {
		return err
	}
	for _, p := range []string{filepath.Join(dir, IndexName), filepath.Join(dir, IndexSignatureName)} {
		if _, err := os.Stat(p); err == nil {
			return fmt.Errorf("%s already exists", p)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, IndexName), text, 0o644); err != nil { //nolint:gosec // G306: public release metadata
		return err
	}
	return os.WriteFile(filepath.Join(dir, IndexSignatureName), sig, 0o644) //nolint:gosec // G306: public release metadata
}
