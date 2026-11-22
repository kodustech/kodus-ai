package toollayer

import (
	"bytes"
	"strings"
)

// maxSymlinkHops bounds the entry's link chain, as readlink -f would.
const maxSymlinkHops = 40

// entryDirs are where the install leaves the CLI's binary, relative to the
// layer root, in the order the TS install script looks (cli-prefix-install.ts).
var entryDirs = []string{".local/bin", "node_modules/.bin"}

// findEntry resolves the CLI's entry script inside the manifest, following
// links within the layer only, and applies today's install-time refusals: an
// ELF binary, or a script without a supported shebang. head returns the first
// bytes of a file's content.
func findEntry(entries []Entry, binary string, head func(sha string) ([]byte, error)) (rel, interpreter string, err error) {
	byPath := make(map[string]*Entry, len(entries))
	for i := range entries {
		byPath[entries[i].Path] = &entries[i]
	}
	sawNonFile := false
	for _, d := range entryDirs {
		real, e, ok := resolveInLayer(byPath, d+"/"+binary)
		if !ok {
			continue
		}
		if e.Type != "file" {
			sawNonFile = true
			continue
		}
		b, err := head(e.SHA256)
		if err != nil {
			return "", "", err
		}
		if len(b) >= 4 && bytes.Equal(b[:4], []byte{0x7f, 'E', 'L', 'F'}) {
			return "", "", refused("native_entry", binary+" is a native executable; it cannot run in the runtime sandbox")
		}
		interp := shebangInterpreter(b)
		if interp == "" {
			return "", "", refused("no_shebang", binary+" has no supported shebang (node, python, bash or sh)")
		}
		return real, interp, nil
	}
	if sawNonFile {
		return "", "", refused("entry_not_file", binary)
	}
	return "", "", refused("entry_missing", binary+" not found after install")
}

// shebangInterpreter mirrors the case statement of the install script.
func shebangInterpreter(b []byte) string {
	line := b
	if i := bytes.IndexByte(b, '\n'); i >= 0 {
		line = b[:i]
	}
	s := strings.ReplaceAll(string(line), "\r", "")
	if !strings.HasPrefix(s, "#!") {
		return ""
	}
	s = s[2:]
	switch {
	case strings.Contains(s, "node"):
		return "node"
	case strings.Contains(s, "python"):
		return "python3"
	case strings.Contains(s, "bash"):
		return "bash"
	case strings.Contains(s, "sh"):
		return "sh"
	}
	return ""
}

// resolveInLayer is readlink -f over the manifest: links are followed,
// ".." never leaves the root, and nothing outside the layer is consulted.
func resolveInLayer(byPath map[string]*Entry, p string) (string, *Entry, bool) {
	comps := strings.Split(p, "/")
	var cur []string
	hops := 0
	for len(comps) > 0 {
		c := comps[0]
		comps = comps[1:]
		switch c {
		case "", ".":
			continue
		case "..":
			if len(cur) == 0 {
				return "", nil, false
			}
			cur = cur[:len(cur)-1]
			continue
		}
		e := byPath[strings.Join(append(append([]string{}, cur...), c), "/")]
		if e == nil {
			return "", nil, false
		}
		if e.Type == "symlink" {
			hops++
			if hops > maxSymlinkHops {
				return "", nil, false
			}
			comps = append(strings.Split(e.Target, "/"), comps...)
			continue
		}
		cur = append(cur, c)
		if len(comps) > 0 && e.Type != "dir" {
			return "", nil, false
		}
	}
	if len(cur) == 0 {
		return "", nil, false
	}
	real := strings.Join(cur, "/")
	return real, byPath[real], true
}
