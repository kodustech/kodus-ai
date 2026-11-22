package toollayer_test

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
)

// tool-layer-key.json is byte-identical to libs/runtime/protocol/tool-layer-key.json,
// which the TS computeToolLayerKey is tested against: the hub computes the key
// in TS, the cell in Go, and a layer is found only when they agree.
type parityInput struct {
	Installer   string   `json:"installer"`
	Argv        []string `json:"argv"`
	Binary      string   `json:"binary"`
	ImageDigest string   `json:"imageDigest"`
	Arch        string   `json:"arch"`
	Registry    string   `json:"registry"`
}

func (p parityInput) keyInput() toollayer.KeyInput {
	return toollayer.KeyInput{Installer: p.Installer, Argv: p.Argv, Binary: p.Binary, ImageDigest: p.ImageDigest, Arch: p.Arch, Registry: p.Registry}
}

func TestKeysMatchTheSharedFixtureTheHubComputesFrom(t *testing.T) {
	raw, err := os.ReadFile("tool-layer-key.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []struct {
			Name  string      `json:"name"`
			Input parityInput `json:"input"`
			Key   string      `json:"key"`
		} `json:"cases"`
		Refused []struct {
			Name    string      `json:"name"`
			Input   parityInput `json:"input"`
			Refusal string      `json:"refusal"`
		} `json:"refused"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) < 8 || len(doc.Refused) < 8 {
		t.Fatalf("fixture has %d cases and %d refusals", len(doc.Cases), len(doc.Refused))
	}
	for _, c := range doc.Cases {
		got, err := toollayer.ComputeKey(c.Input.keyInput())
		if err != nil || got != c.Key {
			t.Errorf("%s: key %q err %v, want %q", c.Name, got, err, c.Key)
		}
	}
	for _, c := range doc.Refused {
		_, err := toollayer.ComputeKey(c.Input.keyInput())
		want := "incomplete"
		if errors.Is(err, toollayer.ErrNoImageDigest) {
			want = "no_image_digest"
		}
		if err == nil || want != c.Refusal {
			t.Errorf("%s: refusal %q (err %v), want %q", c.Name, want, err, c.Refusal)
		}
	}
}
