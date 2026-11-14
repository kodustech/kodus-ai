package buildstate

import (
	"bufio"
	"io"
	"path/filepath"
	"strconv"
	"strings"
)

// OverlayMount is one overlay the kernel has mounted: where, and its lower
// directory.
type OverlayMount struct {
	Target, Lower string
}

// parseOverlayMounts reads /proc/self/mountinfo (proc(5)) and keeps the
// overlays mounted at or under the directory.
func parseOverlayMounts(r io.Reader, under string) ([]OverlayMount, error) {
	under = filepath.Clean(under)
	var out []OverlayMount
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		// id parent major:minor root mountpoint options [optional...] - fstype source superoptions
		pre, post, ok := strings.Cut(sc.Text(), " - ")
		if !ok {
			continue
		}
		fields, sup := strings.Fields(pre), strings.Fields(post)
		if len(fields) < 5 || len(sup) < 3 || sup[0] != "overlay" {
			continue
		}
		target := unescapeMountinfo(fields[4])
		if target != under && !strings.HasPrefix(target, under+"/") {
			continue
		}
		m := OverlayMount{Target: target}
		for _, opt := range strings.Split(sup[2], ",") {
			if v, ok := strings.CutPrefix(opt, "lowerdir="); ok {
				m.Lower = unescapeMountinfo(v)
			}
		}
		out = append(out, m)
	}
	return out, sc.Err()
}

// unescapeMountinfo undoes the kernel's octal escapes (\040 for a space,
// \011, \012, \134).
func unescapeMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
