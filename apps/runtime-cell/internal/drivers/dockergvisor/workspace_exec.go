package dockergvisor

import (
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
)

// repositoryServices maps each other repository of a claim of several
// repositories (root/<alias>, root being the workspace) to the compose
// service built from it: the one whose build context is that directory or
// inside it, the first by name when several are. The primary's own
// directory (projectDir) is left out: its commands run in the public
// service, as a claim of one repository's do. canonical is compose
// config's JSON (absolute build contexts). Nil for a claim of one
// repository (no root).
func repositoryServices(canonical []byte, root, projectDir string) map[string]string {
	if root == "" {
		return nil
	}
	var doc struct {
		Services map[string]struct {
			Build *struct {
				Context string `json:"context"`
			} `json:"build"`
		} `json:"services"`
	}
	if json.Unmarshal(canonical, &doc) != nil {
		return nil
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return nil
	}
	primary := filepath.Clean(projectDir)
	names := make([]string, 0, len(doc.Services))
	for name := range doc.Services {
		names = append(names, name)
	}
	sort.Strings(names)
	out := map[string]string{}
	for _, name := range names {
		b := doc.Services[name].Build
		if b == nil || b.Context == "" || !filepath.IsAbs(b.Context) {
			continue
		}
		rel, err := filepath.Rel(rootAbs, filepath.Clean(b.Context))
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		alias := strings.SplitN(rel, string(filepath.Separator), 2)[0]
		if filepath.Join(rootAbs, alias) == primary {
			continue
		}
		if _, ok := out[alias]; !ok {
			out[alias] = name
		}
	}
	return out
}
