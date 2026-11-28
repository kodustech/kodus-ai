package telemetry

import (
	"encoding/json"
	"io/fs"
	"os"
	"regexp"
	"strings"
	"testing"
)

// Every metric the cell's binaries register is in the taxonomy's catalog:
// a dashboard or an alert can only use names the catalog holds.
func TestEveryCellMetricIsInTheTaxonomy(t *testing.T) {
	var catalog struct {
		Metrics map[string]json.RawMessage `json:"metrics"`
	}
	if err := json.Unmarshal(taxonomyJSON, &catalog); err != nil {
		t.Fatal(err)
	}
	registered := regexp.MustCompile(`\.(?:Counter|Gauge|GaugeFunc)\(\s*"(cell_[a-z0-9_]+)"|# TYPE (kodus_egress_[a-z0-9_]+) `)
	found := 0
	for _, dir := range []string{"..", "../../cmd"} {
		fsys := os.DirFS(dir)
		err := fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			src, err := fs.ReadFile(fsys, path)
			if err != nil {
				return err
			}
			for _, m := range registered.FindAllStringSubmatch(string(src), -1) {
				found++
				name := m[1] + m[2]
				if _, ok := catalog.Metrics[name]; !ok {
					t.Errorf("%s registers %s, which taxonomy.json does not list", path, name)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if found < 30 {
		t.Fatalf("found %d registrations: the pattern no longer matches the code", found)
	}
}
