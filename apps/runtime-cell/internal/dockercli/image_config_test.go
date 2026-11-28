package dockercli

import (
	"slices"
	"strings"
	"testing"
)

// An image's config, as image inspect prints it, gives its env and the
// command it runs; a null entrypoint is none, and an answer past the bound
// is refused rather than read.
func TestParseImageConfig(t *testing.T) {
	got, err := parseImageConfig([]byte(`{"Env":["PATH=/usr/bin","NODE_VERSION=22.11.0"],"Entrypoint":null,"Cmd":["node","dist/main.js"],"Labels":{"a":"b"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got.Env, []string{"PATH=/usr/bin", "NODE_VERSION=22.11.0"}) || got.Entrypoint != nil || !slices.Equal(got.Cmd, []string{"node", "dist/main.js"}) {
		t.Fatalf("got %+v", got)
	}
	if _, err := parseImageConfig([]byte(`{"Env":["` + strings.Repeat("x", maxImageConfigBytes) + `"]}`)); err == nil {
		t.Fatal("an image config past the bound was read")
	}
	if _, err := parseImageConfig([]byte(`not json`)); err == nil {
		t.Fatal("a config that is not JSON was read")
	}
}
