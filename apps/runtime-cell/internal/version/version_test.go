package version

import (
	"runtime/debug"
	"testing"
)

// An operator reading a cell's startup log must be able to tell a release
// binary from one built by hand on a dirty checkout.
func TestResolveTellsReleaseFromHandBuild(t *testing.T) {
	embedded := &debug.BuildInfo{GoVersion: "go1.27.4", Settings: []debug.BuildSetting{
		{Key: "vcs.revision", Value: "abc123"},
		{Key: "vcs.modified", Value: "true"},
	}}
	cases := []struct {
		name            string
		version, commit string
		bi              *debug.BuildInfo
		want            string
	}{
		{"release stamp wins over the embedded revision", "runtime-cell/v1.2.3", "def456", embedded, "runtime-cell/v1.2.3 (def456) go1.27.4"},
		{"hand build on a dirty tree says so", "dev", "", embedded, "dev (abc123-dirty) go1.27.4"},
		{"no build info still reports the stamp", "dev", "", nil, "dev"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolve(tc.version, tc.commit, tc.bi).String(); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
