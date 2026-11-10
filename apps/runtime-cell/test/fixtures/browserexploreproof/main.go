// browserexploreproof validates native runner data using production bounded
// exploration/replay parsers. It never executes files from the evidence.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
	"io"
	"os"
	"time"
)

type evidenceRunner []byte

func (r evidenceRunner) Run(_ context.Context, _ browser.RunSpec, _ []byte, out io.Writer) error {
	_, err := out.Write(r)
	return err
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "browser exploration evidence refused")
		os.Exit(1)
	}
}
func run() error {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 750001))
	if err != nil || len(raw) > 750000 {
		return fmt.Errorf("input bound")
	}
	var evidence struct {
		Mode      string                         `json:"mode"`
		Evidence  protocol.EvidenceLevel         `json:"evidence"`
		Request   protocol.BrowserExploreRequest `json:"request"`
		Probe     protocol.BrowserProbe          `json:"probe"`
		Port      int                            `json:"port"`
		T0Epoch   int64                          `json:"t0Epoch"`
		TarBase64 string                         `json:"tarBase64"`
	}
	if err := json.Unmarshal(raw, &evidence); err != nil {
		return err
	}
	data, err := base64.StdEncoding.DecodeString(evidence.TarBase64)
	if err != nil || len(data) > 512<<10 {
		return fmt.Errorf("tar bound")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if evidence.Mode == "replay" {
		if evidence.Port < 1 || evidence.Port > 65535 || evidence.T0Epoch < 1 {
			return fmt.Errorf("replay identity bound")
		}
		mode := protocol.EvidenceLevelLean
		if evidence.Evidence != "" {
			mode = evidence.Evidence
		}
		if mode != protocol.EvidenceLevelLean && mode != protocol.EvidenceLevelFull {
			return fmt.Errorf("evidence mode")
		}
		result, err := (browser.Capture{Runner: evidenceRunner(data), Redactor: redact.New()}).Run(ctx, browser.Request{Probe: evidence.Probe, Spec: browser.RunSpec{Port: evidence.Port}, Evidence: &mode, T0: time.UnixMilli(evidence.T0Epoch)})
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	if evidence.Mode != "" {
		return fmt.Errorf("mode")
	}
	result, err := (browser.Explorer{Runner: evidenceRunner(data)}).Run(ctx, browser.RunSpec{Port: 3000}, evidence.Request)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
