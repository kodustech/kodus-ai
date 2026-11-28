// Package version is the build identity every cell binary logs at startup
// and prints for -version. The release build stamps it:
//
//	go build -ldflags "-X github.com/kodustech/kodus-ai/apps/runtime-cell/internal/version.Version=runtime-cell/v1.2.3 \
//	                   -X github.com/kodustech/kodus-ai/apps/runtime-cell/internal/version.Commit=<sha>"
//
// A local build is "dev" and falls back to the VCS revision Go embeds with
// -buildvcs.
package version

import (
	"runtime/debug"
)

// Set by the linker (-X); see the package comment.
var (
	Version = "dev"
	Commit  = ""
)

// Info is what a binary reports about the build it is.
type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Go      string `json:"go"`
}

// Get returns the stamped identity, completed from the module build info.
func Get() Info {
	bi, _ := debug.ReadBuildInfo()
	return resolve(Version, Commit, bi)
}

// String is the one-line form printed by -version.
func (i Info) String() string {
	s := i.Version
	if i.Commit != "" {
		s += " (" + i.Commit + ")"
	}
	if i.Go != "" {
		s += " " + i.Go
	}
	return s
}

// resolve prefers what the release stamped; without a stamped commit it uses
// the revision Go embedded at build time, marked -dirty when the tree had
// uncommitted changes, so a hand-built binary is never mistaken for a release.
func resolve(version, commit string, bi *debug.BuildInfo) Info {
	info := Info{Version: version, Commit: commit}
	if bi == nil {
		return info
	}
	info.Go = bi.GoVersion
	if info.Commit != "" {
		return info
	}
	var rev, modified string
	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			modified = s.Value
		}
	}
	if rev != "" && modified == "true" {
		rev += "-dirty"
	}
	info.Commit = rev
	return info
}
