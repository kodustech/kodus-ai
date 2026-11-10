package checkout

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/mirror"
)

const (
	maxDockerfiles     = 200
	maxDockerfileBytes = 1 << 20
)

// isDockerfile is Dockerfile, Dockerfile.<x>, <x>.Dockerfile or <x>.dockerfile.
func isDockerfile(name string) bool {
	l := strings.ToLower(name)
	return l == "dockerfile" || strings.HasPrefix(l, "dockerfile.") || strings.HasSuffix(l, ".dockerfile")
}

// DockerfileImagePins are the Docker Hub images every Dockerfile of the
// checkout names in a FROM: what the cell's mirror serves the claim's
// builds. Bounded like GoSumPins; node_modules and vendor are skipped.
func DockerfileImagePins(repo string) ([]string, error) {
	set := map[string]bool{}
	files := 0
	err := filepath.WalkDir(repo, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "node_modules" || d.Name() == "vendor" || d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !isDockerfile(d.Name()) || !d.Type().IsRegular() {
			return nil
		}
		if files++; files > maxDockerfiles {
			return errors.New("more Dockerfiles than the mirror pins")
		}
		fi, err := d.Info()
		if err != nil || fi.Size() > maxDockerfileBytes {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, p := range mirror.DockerfilePins(data) {
			set[p] = true
		}
		if len(set) > mirror.MaxImagePins {
			return errors.New("the checkout names more images than the mirror serves")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	pins := make([]string, 0, len(set))
	for p := range set {
		pins = append(pins, p)
	}
	slices.Sort(pins)
	return pins, nil
}
