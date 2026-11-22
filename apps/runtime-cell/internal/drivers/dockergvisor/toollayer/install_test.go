package toollayer_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
)

type installCase struct {
	Name           string `json:"name"`
	Command        string `json:"command"`
	OK             bool   `json:"ok"`
	Installer      string `json:"installer"`
	ReasonContains string `json:"reasonContains"`
}

func loadInstallCases(t *testing.T) []installCase {
	t.Helper()
	raw, err := os.ReadFile("cli-install-commands.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []installCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("no cases")
	}
	return f.Cases
}

// The cell accepts only npm and pnpm; every other answer matches the API's.
func TestCheckInstallAnswersLikeTheAPI(t *testing.T) {
	for _, c := range loadInstallCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			got := toollayer.CheckInstall(c.Command)
			cellInstaller := c.Installer == "npm" || c.Installer == "pnpm"
			if c.OK && cellInstaller {
				if !got.OK || got.Installer != c.Installer {
					t.Fatalf("want accepted by %s, got %+v", c.Installer, got)
				}
				if len(got.Argv) == 0 || got.Argv[0] != c.Installer {
					t.Fatalf("argv = %v", got.Argv)
				}
				return
			}
			if got.OK {
				t.Fatalf("want refused, accepted: %+v", got)
			}
			if !c.OK && !strings.Contains(got.Reason, c.ReasonContains) {
				t.Fatalf("reason %q does not contain %q", got.Reason, c.ReasonContains)
			}
		})
	}
}

func TestInstallFixtureIsByteIdenticalToTheProtocolCopy(t *testing.T) {
	cell, err := os.ReadFile("cli-install-commands.json")
	if err != nil {
		t.Fatal(err)
	}
	proto, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "..", "libs", "runtime", "protocol", "cli-install-commands.json"))
	if err != nil {
		t.Skipf("protocol copy not in this checkout: %v", err)
	}
	if !bytes.Equal(cell, proto) {
		t.Fatal("cli-install-commands.json differs from libs/runtime/protocol: change both in one PR")
	}
}
