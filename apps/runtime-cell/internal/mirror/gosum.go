package mirror

import (
	"bufio"
	"bytes"
	"fmt"
	"strings"
)

// MaxGoPins bounds what one go.sum may pin (a large monorepo has a few
// thousand lines).
const MaxGoPins = 20_000

// ParseGoSum reads a go.sum into the module@version pairs it pins (a
// "<v>/go.mod" line pins the same version). A malformed line is refused:
// the pins are the claim's whole allowlist for Go.
func ParseGoSum(data []byte) (map[string]bool, error) {
	pins := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		f := strings.Fields(line)
		if len(f) != 3 || !strings.HasPrefix(f[2], "h1:") {
			return nil, fmt.Errorf("go.sum line %d: not \"<module> <version> h1:<hash>\"", n)
		}
		version := strings.TrimSuffix(f[1], "/go.mod")
		if !validModule(f[0]) || !validVersion(version) {
			return nil, fmt.Errorf("go.sum line %d: bad module or version", n)
		}
		pins[f[0]+"@"+version] = true
		if len(pins) > MaxGoPins {
			return nil, fmt.Errorf("go.sum pins more than %d modules", MaxGoPins)
		}
	}
	return pins, sc.Err()
}
