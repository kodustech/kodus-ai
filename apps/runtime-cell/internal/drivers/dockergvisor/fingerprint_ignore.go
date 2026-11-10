package dockergvisor

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockerignore"
)

// maxDefinitionBytes bounds the Dockerfile and ignore file the cell reads
// whole; past it the build's context is hashed whole instead.
const maxDefinitionBytes = 1 << 20

// exclusions is what of a build's context BuildKit will never send: the
// entries its ignore file leaves out. The cell only ever leaves out of the
// fingerprint what the builder is certain to leave out of the build; in
// any doubt it leaves out nothing, which costs a rebuild, never a stale
// image.
type exclusions struct {
	matcher *dockerignore.Matcher // nil: nothing is left out
	source  string                // the ignore file read, "" for none
	// definition is what decides the build besides the context: the
	// Dockerfile and the ignore file, hashed even when the ignore file
	// leaves them out (BuildKit still reads them).
	definition []definitionFile
}

type definitionFile struct{ name, sum string }

// contextExclusions reads the ignore file BuildKit's Dockerfile frontend
// would use: "<Dockerfile>.dockerignore" next to the Dockerfile, else the
// context's ".dockerignore". An empty Dockerfile-specific file is taken as
// is, where some BuildKit versions fall back to the context's: leaving out
// less than the builder is the safe way to differ.
func contextExclusions(b sandbox.Build) exclusions {
	var ex exclusions
	df, err := readDefinition(b.Context, b.Dockerfile)
	if err != nil {
		return ex // a linked or odd Dockerfile: what BuildKit reads is not known here
	}
	ex.definition = append(ex.definition, definitionFile{"dockerfile", sha256Hex(df)})
	if !standardFrontend(df, b.Args) {
		return ex
	}
	for _, name := range []string{b.Dockerfile + ".dockerignore", ".dockerignore"} {
		data, err := readDefinition(b.Context, name)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return ex // linked, a directory, too large: not sure what BuildKit reads
		}
		ex.definition = append(ex.definition, definitionFile{name, sha256Hex(data)})
		// A file BuildKit refuses fails the build; nothing is left out here.
		if m, err := dockerignore.Compile(data); err == nil {
			ex.matcher, ex.source = m, name
		}
		return ex
	}
	return ex
}

// readDefinition reads a file the frontend reads by name, so through
// links (fsutil's FollowPaths). It accepts only a regular file reached
// through real directories: through a link, the bytes BuildKit reads could
// sit in a part of the context the ignore file leaves out, and the cell
// would not see them change.
func readDefinition(root, rel string) ([]byte, error) {
	rel = filepath.Clean(rel)
	if !filepath.IsLocal(rel) {
		return nil, fmt.Errorf("%s is not inside the context", rel)
	}
	parts := strings.Split(rel, string(filepath.Separator))
	at := root
	for i, part := range parts {
		at = filepath.Join(at, part)
		info, err := os.Lstat(at)
		if err != nil {
			return nil, err
		}
		last := i == len(parts)-1
		if last && !info.Mode().IsRegular() || !last && !info.IsDir() {
			return nil, fmt.Errorf("%s is not a plain file", rel)
		}
	}
	f, err := openRegular(at)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxDefinitionBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxDefinitionBytes {
		return nil, fmt.Errorf("%s is too large", rel)
	}
	return data, nil
}

func sha256Hex(data []byte) string {
	s := sha256.Sum256(data)
	return hex.EncodeToString(s[:])
}

var (
	// syntaxDirective is a Dockerfile's "# syntax=" (or "// syntax=")
	// parser directive, which hands the build to another frontend.
	syntaxDirective = regexp.MustCompile(`(?i)^(?:#|//)\s*syntax\s*=\s*(.*?)\s*$`)
	// floatingFrontend is the official frontend at a tag that follows its
	// latest 1.x release, which reads ignore files as the builder does.
	floatingFrontend = regexp.MustCompile(`^(?:docker\.io/)?docker/dockerfile(?::(?:1|1-labs|labs|latest))?$`)
)

// standardFrontend reports whether the build reads its ignore file the way
// this package knows: the builder's own frontend or the official one at a
// floating 1.x tag. A pinned or third-party frontend may read another file
// or none at all (sending the whole context), so it gets no exclusions.
// Directives are looked for in every leading comment, blank lines
// included, and a JSON header counts as one: over-reading a directive
// only costs the exclusions.
func standardFrontend(dockerfile []byte, args map[string]string) bool {
	if _, set := args["BUILDKIT_SYNTAX"]; set {
		return false
	}
	for _, line := range strings.Split(string(dockerfile), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
			continue
		case strings.HasPrefix(line, "{"):
			return false
		case !strings.HasPrefix(line, "#") && !strings.HasPrefix(line, "//"):
			return true // the first instruction: no directive after it
		}
		if m := syntaxDirective.FindStringSubmatch(line); m != nil && !floatingFrontend.MatchString(m[1]) {
			return false
		}
	}
	return true
}

// contextFilter leaves out of the fingerprint's walk what the build is
// never sent.
type contextFilter struct {
	walk *dockerignore.Walk // nil: everything is sent
	held heldDirs
}

func newContextFilter(m *dockerignore.Matcher) *contextFilter {
	if m == nil {
		return &contextFilter{}
	}
	return &contextFilter{walk: m.Walk()}
}

// admit reports whether an entry, visited in the walk's order, is sent
// and so hashed. A left-out directory nothing below can be put back into
// is skipped whole (filepath.SkipDir). The context's root is always sent.
func (c *contextFilter) admit(rel string, e fs.DirEntry, write func(...string)) (bool, error) {
	if c.walk != nil && rel != "." {
		excluded, skip := c.walk.Visit(rel, e.IsDir())
		if skip {
			return false, filepath.SkipDir
		}
		if excluded {
			if !e.IsDir() {
				return false, nil
			}
			info, err := e.Info()
			if err != nil {
				return false, err
			}
			c.held.hold(rel, info.Mode().Perm().String())
			return false, nil
		}
	}
	c.held.release(rel, write)
	return true, nil
}

// heldDirs are left-out directories the walk went into because an
// exception may put back something below them. BuildKit sends such a
// directory (its mode) only along with something below it, so each is
// hashed only when, and just before, the first entry below it is.
type heldDirs []heldDir

type heldDir struct{ rel, perm string }

// hold notes a left-out directory the walk enters.
func (h *heldDirs) hold(rel, perm string) {
	h.leave(rel)
	*h = append(*h, heldDir{rel, perm})
}

// release hashes the held directories above an entry that is hashed.
func (h *heldDirs) release(rel string, write func(...string)) {
	h.leave(rel)
	for _, d := range *h {
		write("dir", d.rel, d.perm)
	}
	*h = (*h)[:0]
}

// leave drops the held directories the walk has left, the ones not above rel.
func (h *heldDirs) leave(rel string) {
	for len(*h) > 0 && !strings.HasPrefix(rel, (*h)[len(*h)-1].rel+"/") {
		*h = (*h)[:len(*h)-1]
	}
}
