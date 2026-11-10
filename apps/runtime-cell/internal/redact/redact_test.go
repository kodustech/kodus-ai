package redact

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type golden struct {
	Cases []struct {
		Secret   string   `json:"secret"`
		Variants []string `json:"variants"`
	} `json:"cases"`
	Mask struct {
		Text    string   `json:"text"`
		Secrets []string `json:"secrets"`
		Masked  string   `json:"masked"`
	} `json:"mask"`
}

// The port gives the same spellings as the TS original
// (testdata/ts-variants.json, written by
// libs/runtime/redaction/scripts/dump-variants-golden.ts).
func TestVariantsMatchTheTSOriginal(t *testing.T) {
	b, err := os.ReadFile("testdata/ts-variants.json")
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) == 0 {
		t.Fatal("no golden cases")
	}
	for _, c := range g.Cases {
		got := Variants(c.Secret)
		sort.Strings(got)
		want := append([]string(nil), c.Variants...)
		sort.Strings(want)
		if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
			t.Errorf("Variants(%q)\n got %q\nwant %q", c.Secret, got, want)
		}
	}
	// maskSecrets with "***": the same text comes out.
	known := make([]Known, 0, len(g.Mask.Secrets))
	for _, s := range g.Mask.Secrets {
		known = append(known, Known{Label: "x", Value: s})
	}
	r := New(known...)
	r.rules = nil
	got, _ := r.String(g.Mask.Text)
	if got = strings.ReplaceAll(got, Marker("x"), "***"); got != g.Mask.Masked {
		t.Errorf("masked text differs from maskSecrets\n got %q\nwant %q", got, g.Mask.Masked)
	}
}

// The Go copy of the rule data file is the TS one, byte for byte.
func TestRulesFileMatchesTS(t *testing.T) {
	ts, err := os.ReadFile("../../../../libs/runtime/redaction/gitleaks-rules.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ts, RulesJSON()) {
		t.Fatal("rules/gitleaks-rules.json differs from libs/runtime/redaction/gitleaks-rules.json: copy it over")
	}
	var meta struct {
		Source struct {
			Commit  string `json:"commit"`
			License string `json:"license"`
		} `json:"source"`
		License string `json:"license"`
	}
	_ = json.Unmarshal(ts, &meta)
	if len(meta.Source.Commit) != 40 || meta.Source.License != "MIT" || !strings.Contains(meta.License, "Zachary Rice") {
		t.Fatalf("the vendored rules must carry the gitleaks commit and MIT notice: %+v", meta.Source)
	}
}

// Every rule redacts its own examples, with its own marker.
func TestEveryRuleRedactsItsExamples(t *testing.T) {
	if len(DefaultRules()) < 15 {
		t.Fatalf("only %d rules", len(DefaultRules()))
	}
	for _, rule := range DefaultRules() {
		if len(rule.Examples) == 0 {
			t.Errorf("%s: no example", rule.ID)
		}
		for _, ex := range rule.Examples {
			got, n := Patterns(ex)
			if n == 0 || !strings.Contains(got, Marker(rule.ID)) {
				t.Errorf("%s: %q → %q (%d)", rule.ID, ex, got, n)
			}
		}
	}
}

func TestPatternsLeaveOrdinaryOutputAlone(t *testing.T) {
	for _, s := range []string{
		"GET /orders/42 200 12ms",
		"token refreshed successfully for user 42",
		"key: value_that_is_long_enough",
		"sha 3e93285db1a2b3c4d5e6f708192a3b4c5d6e7f80",
		"Bearer",
	} {
		if got, n := Patterns(s); n != 0 || got != s {
			t.Errorf("%q → %q (%d)", s, got, n)
		}
	}
}

// A secret group keeps the context around the value.
func TestSecretGroupKeepsContext(t *testing.T) {
	got, n := Patterns("Authorization: Bearer abcdefgh12345678\nnext")
	if n != 1 || got != "Authorization: Bearer [redacted:generic-bearer]\nnext" {
		t.Fatalf("%q (%d)", got, n)
	}
}

// S-51: a command prints the download token in plain, base64 and percent;
// the app log has an AWS key and a JWT the cell never knew. None of them
// reaches the step.result, and the count is recorded.
func TestS51StepResultCarriesNoSecret(t *testing.T) {
	token := "ghs_" + strings.Repeat("Dl0", 12)
	seed := "s3ed/P@ss+w0rd"
	aws := "AKIAIOSFODNN7EXAMPLE"
	jwt := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
	basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
	stdout := strings.Join([]string{
		"plain " + token,
		"b64 " + base64.StdEncoding.EncodeToString([]byte(token)),
		"basic " + basic,
		"pct " + url.QueryEscape("tok="+token+"&x=1"),
		"dsn postgres://app:" + EncodeURIComponent(seed) + "@db/app",
	}, "\n")
	stderr := "app: loaded AWS_ACCESS_KEY_ID=" + aws + "\napp: session " + jwt + "\n"
	res := &protocol.StepResultBody{
		StepID: "6f1c1c1e-0000-4000-8000-000000000001", Executor: protocol.ExecutorVM, ImageID: "img", VMHealth: protocol.VMHealthOk,
		Exec: &protocol.ExecResult{Stdout: stdout, Stderr: stderr},
		Probe: &protocol.ProbeResult{
			HTTP:     &protocol.ProbeResultHTTP{Status: 200, Headers: map[string]string{"set-cookie": "s=" + jwt}, Body: `{"debug":"` + aws + `"}`},
			SQL:      &protocol.ProbeResultSQL{Columns: []string{"t"}, Rows: [][]json.RawMessage{{json.RawMessage(`"` + token + `"`), json.RawMessage(`42`)}}},
			Requests: []protocol.RequestLogEntry{{Method: "GET", Route: "/cb?token=" + token, Status: 200}},
		},
	}
	n := New(Known{Label: "download-token", Value: token}, Known{Label: "seed-password", Value: seed}).StepResult(res)
	frame, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	for _, leaked := range []string{token, base64.StdEncoding.EncodeToString([]byte(token)), aws, jwt, "Dl0Dl0Dl0", seed, EncodeURIComponent(seed)} {
		if bytes.Contains(frame, []byte(leaked)) {
			t.Errorf("step.result still carries %q:\n%s", leaked, frame)
		}
	}
	if res.Redactions == nil || *res.Redactions != int64(n) || n < 11 {
		t.Fatalf("redactions = %v, n = %d", res.Redactions, n)
	}
	for _, m := range []string{Marker("download-token"), Marker("seed-password"), Marker("aws-access-token"), Marker("jwt")} {
		if !bytes.Contains(frame, []byte(m)) {
			t.Errorf("no %s in %s", m, frame)
		}
	}
}

func TestStepResultStaysUnderTheProtocolCap(t *testing.T) {
	secret := "abc12345"
	res := &protocol.StepResultBody{Exec: &protocol.ExecResult{Stdout: strings.Repeat(secret, MaxExecStream/len(secret))}}
	New(Known{Label: "seed-password", Value: secret}).StepResult(res)
	if len(res.Exec.Stdout) > MaxExecStream || !res.Exec.Truncated {
		t.Fatalf("len %d truncated %v", len(res.Exec.Stdout), res.Exec.Truncated)
	}
}

// A known value in a numeric or jsonb cell, a header name and a column
// name all left the cell before: only string cells and header values were
// redacted.
func TestStepResultRedactsNonStringCellsHeaderNamesAndColumns(t *testing.T) {
	token := "ghs_" + strings.Repeat("Zq9", 12)
	res := &protocol.StepResultBody{Probe: &protocol.ProbeResult{
		HTTP: &protocol.ProbeResultHTTP{Headers: map[string]string{"x-" + token: "1"}},
		SQL: &protocol.ProbeResultSQL{Columns: []string{"c_" + token}, Rows: [][]json.RawMessage{{
			json.RawMessage(`987654321`),
			json.RawMessage(`{"auth":"` + token + `"}`),
			json.RawMessage(`["` + token + `"]`),
			json.RawMessage(`42`),
		}}},
	}}
	r := New(Known{Label: "download-token", Value: token}, Known{Label: "pin", Value: "987654321"})
	if n := r.StepResult(res); n < 5 {
		t.Fatalf("redactions %d", n)
	}
	frame, _ := json.Marshal(res)
	if bytes.Contains(frame, []byte(token)) || bytes.Contains(frame, []byte("987654321")) {
		t.Fatalf("leaked: %s", frame)
	}
	for _, cell := range res.Probe.SQL.Rows[0] {
		if !json.Valid(cell) {
			t.Fatalf("cell is no longer JSON: %s", cell)
		}
	}
	if string(res.Probe.SQL.Rows[0][3]) != "42" {
		t.Fatalf("an ordinary number changed: %s", res.Probe.SQL.Rows[0][3])
	}
}

// A one-character known value replaced the digits inside the sentinel an
// earlier, longer value left, so the marker never came back and NUL bytes
// went out.
func TestShortKnownValueDoesNotBreakEarlierMarkers(t *testing.T) {
	r := New(Known{Label: "long", Value: "abcdefgh"}, Known{Label: "pw", Value: "0"})
	r.rules = nil
	out, _ := r.String("abcdefgh and 0")
	if strings.Contains(out, "\x00") || out != Marker("long")+" and "+Marker("pw") {
		t.Fatalf("%q", out)
	}
}

func TestMaskingWriterMasksAcrossChunkBoundaries(t *testing.T) {
	secret := "kodus-test-token-6c1f9a2e7b"
	text := "a " + secret + " b " + base64.StdEncoding.EncodeToString([]byte(secret)) + " c " + secret
	for chunk := 1; chunk <= len(text); chunk += 7 {
		var out bytes.Buffer
		w := NewMaskingWriter(&out, []string{secret}, "***")
		for i := 0; i < len(text); i += chunk {
			_, _ = w.Write([]byte(text[i:min(i+chunk, len(text))]))
		}
		_ = w.Close()
		if strings.Contains(out.String(), secret) || strings.Contains(out.String(), "6c1f9a2e") || !strings.HasPrefix(out.String(), "a *** b ") {
			t.Fatalf("chunk %d: %q", chunk, out.String())
		}
		if want := Mask(text, []string{secret}, "***"); out.String() != want {
			t.Fatalf("chunk %d: stream %q, whole %q", chunk, out.String(), want)
		}
	}
}
