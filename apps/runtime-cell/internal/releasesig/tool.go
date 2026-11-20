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
	"strings"
	"time"
)

// RunTool is cmd/release-sign: generate a key pair, write the release
// directory's PROTOCOL (speaks: what the build's cell speaks), or sign its
// SHA256SUMS into SHA256SUMS.sig. Exit 0 done, 1 failed, 2 usage.
func RunTool(args []string, speaks Protocol, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = fmt.Fprintln(stderr, "usage: release-sign generate -private FILE -public FILE | protocol -dir DIR | sign -key FILE -release NAME -dir DIR | index -key FILE -latest NAME -minimum NAME [-valid-days 90] [-revoke ID,ID] -dir DIR | bundle -key FILE -release NAME -release-dir DIR [-images FILE] [-runsc ARCH=FILE,...] -out DIR")
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
	case "protocol":
		dir := fs.String("dir", "", "the release directory, before SHA256SUMS is made over it")
		if fs.Parse(args[1:]) != nil || *dir == "" {
			return 2
		}
		if err = writeProtocol(*dir, speaks); err == nil {
			_, _ = fmt.Fprintf(stdout, "wrote %s: protocol v%d to v%d\n", filepath.Join(*dir, ProtocolName), speaks.Min, speaks.Max)
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
	case "index":
		key := fs.String("key", "", "the private key file")
		latest := fs.String("latest", "", "the latest release (the one just published)")
		minimum := fs.String("minimum", "", "the lowest release a cell may install (a known-bad one below it is refused)")
		days := fs.Int("valid-days", 90, "how long the index holds; a cell refuses an expired one, so it must be re-issued before")
		revoke := fs.String("revoke", "", "comma-separated key ids to revoke")
		dir := fs.String("dir", "", "where RELEASE-INDEX and RELEASE-INDEX.sig go")
		if fs.Parse(args[1:]) != nil || *key == "" || *latest == "" || *minimum == "" || *dir == "" || *days < 1 {
			return 2
		}
		var revoked []string
		for _, k := range strings.Split(*revoke, ",") {
			if k = strings.TrimSpace(k); k != "" {
				revoked = append(revoked, k)
			}
		}
		var keyText []byte
		if keyText, err = os.ReadFile(*key); err == nil {
			var priv ed25519.PrivateKey
			if priv, err = ParsePrivateKey(keyText); err == nil {
				now := time.Now().UTC()
				err = signIndexFile(priv, *dir, Index{Issued: now, Expires: now.Add(time.Duration(*days) * 24 * time.Hour), Latest: *latest, Minimum: *minimum, RevokedKeys: revoked})
			}
		}
		if err == nil {
			_, _ = fmt.Fprintf(stdout, "signed %s: latest %s, minimum %s, valid %d days\n", filepath.Join(*dir, IndexName), *latest, *minimum, *days)
		}
	case "bundle":
		key := fs.String("key", "", "the private key file (the release key that signed SHA256SUMS and the index)")
		release := fs.String("release", "", "the release's name")
		relDir := fs.String("release-dir", "", "the signed release: SHA256SUMS(.sig), RELEASE-INDEX(.sig), PROTOCOL and the binaries")
		images := fs.String("images", "", "tab-separated component, reference (repository@sha256:...) and OCI archive per line")
		runsc := fs.String("runsc", "", "comma-separated ARCH=FILE: the gvisor.tar.bz2 of each arch (x86_64, aarch64)")
		out := fs.String("out", "", "the bundle directory to create")
		if fs.Parse(args[1:]) != nil || *key == "" || *release == "" || *relDir == "" || *out == "" {
			return 2
		}
		if err = bundleDir(*key, *release, *relDir, *images, *runsc, *out); err == nil {
			_, _ = fmt.Fprintf(stdout, "bundled release %s into %s (signed %s)\n", *release, *out, BundleSignatureName)
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

// bundleDir is the bundle command: the inputs read, BuildBundle at now.
func bundleDir(keyPath, release, relDir, imagesFile, runscList, out string) error {
	keyText, err := os.ReadFile(keyPath) //nolint:gosec // G304: the key file the release job wrote
	if err != nil {
		return err
	}
	priv, err := ParsePrivateKey(keyText)
	if err != nil {
		return err
	}
	var images []ImageInput
	if imagesFile != "" {
		text, err := os.ReadFile(imagesFile) //nolint:gosec // G304: the image list the release job wrote
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(text), "\n") {
			if line = strings.TrimSpace(line); line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			f := strings.Split(line, "\t")
			if len(f) != 3 {
				return fmt.Errorf("%s: line %d is not \"<component>\\t<reference>\\t<archive>\"", imagesFile, i+1)
			}
			images = append(images, ImageInput{Component: f[0], Ref: f[1], Archive: f[2]})
		}
	}
	runsc := map[string]string{}
	for _, kv := range strings.Split(runscList, ",") {
		if kv = strings.TrimSpace(kv); kv == "" {
			continue
		}
		arch, file, ok := strings.Cut(kv, "=")
		if !ok || arch == "" || file == "" {
			return fmt.Errorf("-runsc: %q is not ARCH=FILE", kv)
		}
		runsc[arch] = file
	}
	return BuildBundle(priv, release, relDir, images, runsc, out, time.Now().UTC())
}
