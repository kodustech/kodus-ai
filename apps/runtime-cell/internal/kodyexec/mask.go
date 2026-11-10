package kodyexec

import (
	"sort"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// Ported from libs/code-review/infrastructure/agents/custom-agent-cli/cli-output-mask.ts.
// The spellings live in internal/redact (one port, checked against the TS
// original); kody-exec masks with "***" inside the VM, and the cell agent
// redacts again with markers before anything leaves the cell (S-51).

const Redaction = "***"

// SecretVariants returns the encodings under which a known secret can leak
// in command output: raw, base64 at every alignment, base64url, percent,
// hex, and JSON escapes.
func SecretVariants(secret string) []string { return redact.Variants(secret) }

// MaskSecrets replaces every variant of every secret, longest first.
func MaskSecrets(text string, secrets []string) string {
	if text == "" || len(secrets) == 0 {
		return text
	}
	set := map[string]bool{}
	for _, s := range secrets {
		for _, v := range SecretVariants(s) {
			set[v] = true
		}
	}
	vs := make([]string, 0, len(set))
	for v := range set {
		vs = append(vs, v)
	}
	sort.SliceStable(vs, func(i, j int) bool { return len(vs[i]) > len(vs[j]) })
	for _, v := range vs {
		text = strings.ReplaceAll(text, v, Redaction)
	}
	return text
}
