package releasesig

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// RunTool is cmd/release-sign: generate a key pair, or sign a release
// directory's SHA256SUMS into SHA256SUMS.sig. Exit 0 done, 1 failed, 2 usage.
func RunTool(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = fmt.Fprintln(stderr, "usage: release-sign generate -private FILE -public FILE | sign -key FILE -release NAME -dir DIR")
		return 2
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	fs.SetOutput(stderr)
	var err error
	switch args[0] {
	case "generate":
		private := fs.String("private", "", "where the private key goes (mode 0600; never committed)")
		public := fs.String("public", "", "where the public key line goes (to pin)")
		if fs.Parse(args[1:]) != nil || *private == "" || *public == "" {
			return 2
		}
		var id string
		if id, err = generate(*private, *public); err == nil {
			_, _ = fmt.Fprintf(stdout, "key %s: pin %s, keep %s secret\n", id, *public, *private)
		}
	case "sign":
		key := fs.String("key", "", "the private key file")
		release := fs.String("release", "", "the release's name, as the installer asks for it")
		dir := fs.String("dir", "", "the release directory: SHA256SUMS and the files it lists")
		if fs.Parse(args[1:]) != nil || *key == "" || *release == "" || *dir == "" {
			return 2
		}
		if err = signDir(*key, *release, *dir); err == nil {
			_, _ = fmt.Fprintf(stdout, "signed %s for release %s\n", filepath.Join(*dir, ManifestName), *release)
		}
	default:
		_, _ = fmt.Fprintf(stderr, "release-sign: unknown command %q\n", args[0])
		return 2
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "release-sign:", err)
		return 1
	}
	return 0
}

func generate(privatePath, publicPath string) (string, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	f, err := os.OpenFile(privatePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // G304: the path the release owner names
	if err != nil {
		return "", err
	}
	_, err = f.WriteString(FormatPrivateKey(priv))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(publicPath, []byte(FormatPublicKey(pub)), 0o644); err != nil { //nolint:gosec // G306: a public key, to commit
		return "", err
	}
	return KeyID(pub), nil
}

// signDir signs dir's SHA256SUMS after checking every file it lists is
// there with its bytes: the tooling never signs a manifest that is wrong.
func signDir(keyPath, release, dir string) error {
	keyText, err := os.ReadFile(keyPath) //nolint:gosec // G304: the key file the release job wrote
	if err != nil {
		return err
	}
	priv, err := ParsePrivateKey(keyText)
	if err != nil {
		return err
	}
	manifestPath := filepath.Join(dir, ManifestName)
	manifest, err := os.ReadFile(manifestPath) //nolint:gosec // G304: the release directory
	if err != nil {
		return err
	}
	listed, err := ParseManifest(manifest, manifestPath)
	if err != nil {
		return err
	}
	for name, sha := range listed {
		if err := CheckFile(filepath.Join(dir, name), sha); err != nil {
			return err
		}
	}
	sig, err := Sign(priv, release, manifest)
	if err != nil {
		return err
	}
	sigPath := filepath.Join(dir, SignatureName)
	if _, err := os.Stat(sigPath); err == nil {
		return errors.New(sigPath + " already exists")
	}
	return os.WriteFile(sigPath, sig, 0o644) //nolint:gosec // G306: a signature, published with the release
}
