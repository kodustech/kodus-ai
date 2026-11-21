package exercised

import (
	"fmt"
	"strings"
)

// segment is one decoded source map segment: a generated position and the
// original one it maps to (0-based lines and UTF-16 columns, ECMA-426).
type segment struct {
	genLine, genCol int
	source, srcLine int
}

const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

var b64Value = func() (t [256]int8) {
	for i := range t {
		t[i] = -1
	}
	for i := 0; i < len(b64); i++ {
		t[b64[i]] = int8(i)
	}
	return t
}()

// maxSegments bounds a decode: past it the map is not read at all.
const maxSegments = 2_000_000

// decodeMappings reads a Source Map v3 mappings string. Segments of one
// field (no source) are skipped: they map to nothing.
func decodeMappings(mappings string) ([]segment, error) {
	var out []segment
	var src, srcLine, srcCol, name int
	for line, group := range strings.Split(mappings, ";") {
		genCol := 0
		for _, seg := range strings.Split(group, ",") {
			if seg == "" {
				continue
			}
			var f [5]int
			n := 0
			for i := 0; i < len(seg); {
				if n == 5 {
					return nil, fmt.Errorf("exercised: a mapping segment has more than 5 fields")
				}
				v, used, err := vlq(seg[i:])
				if err != nil {
					return nil, err
				}
				f[n] = v
				n++
				i += used
			}
			genCol += f[0]
			if n == 1 {
				continue
			}
			if n < 4 {
				return nil, fmt.Errorf("exercised: a mapping segment has %d fields", n)
			}
			src += f[1]
			srcLine += f[2]
			srcCol += f[3]
			if n == 5 {
				name += f[4]
			}
			if genCol < 0 || src < 0 || srcLine < 0 {
				return nil, fmt.Errorf("exercised: a mapping segment points before the start")
			}
			if len(out) == maxSegments {
				return nil, fmt.Errorf("exercised: more than %d mapping segments", maxSegments)
			}
			out = append(out, segment{genLine: line, genCol: genCol, source: src, srcLine: srcLine})
		}
	}
	return out, nil
}

// vlq reads one base64 VLQ value and how many bytes it took.
func vlq(s string) (int, int, error) {
	var v, shift int
	for i := 0; i < len(s); i++ {
		d := int(b64Value[s[i]])
		if d < 0 {
			return 0, 0, fmt.Errorf("exercised: %q is not a base64 VLQ digit", s[i])
		}
		if shift > 30 {
			return 0, 0, fmt.Errorf("exercised: a VLQ value overflows")
		}
		v |= (d & 31) << shift
		shift += 5
		if d&32 == 0 {
			if v&1 == 1 {
				return -(v >> 1), i + 1, nil
			}
			return v >> 1, i + 1, nil
		}
	}
	return 0, 0, fmt.Errorf("exercised: a VLQ value ends mid-digit")
}
