package protocol

import (
	"errors"
	"strings"
	"testing"
)

const (
	uuidA = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b"
	uuidB = "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
)

func frame(typ, body string) string {
	return `{"v":1,"id":"` + uuidA + `","cellId":"cell-1","claimId":"claim-1","type":"` + typ + `","body":` + body + `}`
}

const (
	probeResultJSON = `{"stepId":"` + uuidB + `","executor":"observer","imageId":"i","http":{"status":200,"headers":{},"body":"[]"},"requests":[],"durationMs":12,"transport":"ok"}`
	execResultJSON  = `{"exitCode":0,"stdout":"","stderr":"","truncated":false,"durationMs":1}`
	acquireJSON     = `{"orgId":"org-a","environmentId":"env","imageId":"img-1","side":"base","sha":"0123456789abcdef0123456789abcdef01234567","consumer":"setup","repo":{"provider":"github","fullName":"acme/shop","apiBase":"https://api.github.com"},"repoToken":"t","expose":[],"hardExpiresAt":"2026-10-30T13:00:00Z","diagnosticHold":true}`
)

const httpProbeRun = `{"stepId":"` + uuidB + `","probe":{"id":"p1","origin":"agent","purpose":"list users","expected":"200 with two users","compare":["status","json"],"spec":{"kind":"http","target":{"service":"api","port":3000},"method":"GET","path":"/users","timeoutMs":5000}}}`

func codeOf(t *testing.T, err error) DecodeErrorCode {
	t.Helper()
	var de *DecodeError
	if !errors.As(err, &de) {
		t.Fatalf("expected DecodeError, got %v", err)
	}
	return de.Code
}

func TestDecodeProbeRun(t *testing.T) {
	m, err := Decode([]byte(frame("probe.run", httpProbeRun)))
	if err != nil {
		t.Fatal(err)
	}
	b, ok := m.Body.(*ProbeRunBody)
	if !ok {
		t.Fatalf("body is %T", m.Body)
	}
	if b.Probe.Spec.Kind() != "http" || b.Probe.Spec.HTTP.Path != "/users" || b.Probe.Spec.HTTP.Target.Port != 3000 {
		t.Fatalf("bad decode: %+v", b.Probe.Spec.HTTP)
	}
}

// S-30: every frame two parsers could read differently is refused.
func TestDecodeRefusesAmbiguousFrames(t *testing.T) {
	cases := map[string]struct {
		frame string
		code  DecodeErrorCode
	}{
		"duplicate envelope key":      {`{"v":1,"v":1,"id":"` + uuidA + `","cellId":"c","type":"ack","body":{}}`, CodeDuplicateKey},
		"duplicate body key":          {frame("nack", `{"code":"a","code":"b","message":""}`), CodeDuplicateKey},
		"case variant key":            {`{"v":1,"id":"` + uuidA + `","cellid":"c","type":"ack","body":{}}`, CodeInvalidEnvelope},
		"case variant body key":       {frame("probe.run", strings.Replace(httpProbeRun, `"stepId"`, `"stepid"`, 1)), CodeInvalidBody},
		"unknown envelope field":      {`{"v":1,"id":"` + uuidA + `","cellId":"c","type":"ack","body":{},"x":1}`, CodeInvalidEnvelope},
		"unknown body field":          {frame("exec.cancel", `{"stepId":"`+uuidB+`","x":1}`), CodeInvalidBody},
		"__proto__ in the body":       {frame("exec.cancel", `{"stepId":"`+uuidB+`","__proto__":{"x":1}}`), CodeInvalidJSON},
		"__proto__ deep":              {frame("probe.run", strings.Replace(httpProbeRun, `"target":{`, `"target":{"__proto__":null,`, 1)), CodeInvalidJSON},
		"__proto__ in the envelope":   {`{"__proto__":{},"v":1,"id":"` + uuidA + `","cellId":"c","type":"ack","body":{}}`, CodeInvalidJSON},
		"claim frame without claimId": {`{"v":1,"id":"` + uuidA + `","cellId":"c","type":"exec.cancel","body":{"stepId":"` + uuidB + `"}}`, CodeInvalidEnvelope},
		"ack without re":              {frame("ack", `{}`), CodeInvalidEnvelope},
		"vm result with a probe":      {frame("step.result", `{"stepId":"`+uuidB+`","executor":"vm","imageId":"i","vmHealth":"ok","probe":`+probeResultJSON+`}`), CodeInvalidBody},
		"observer result with exec":   {frame("step.result", `{"stepId":"`+uuidB+`","executor":"observer","imageId":"i","vmHealth":"ok","exec":`+execResultJSON+`}`), CodeInvalidBody},
		"exec and probe together":     {frame("step.result", `{"stepId":"`+uuidB+`","executor":"vm","imageId":"i","vmHealth":"ok","exec":`+execResultJSON+`,"probe":`+probeResultJSON+`}`), CodeInvalidBody},
		"hold on a runtime claim":     {frame("claim.acquire", strings.Replace(acquireJSON, `"consumer":"setup"`, `"consumer":"runtime"`, 1)), CodeInvalidBody},
		"unknown message type":        {frame("exec.everything", `{}`), CodeInvalidEnvelope},
		"unsupported version":         {strings.Replace(frame("exec.cancel", `{"stepId":"`+uuidB+`"}`), `"v":1`, `"v":7`, 1), CodeUnsupportedVersion},
		"stepId not a uuid":           {frame("exec.cancel", `{"stepId":"1"}`), CodeInvalidBody},
		"trailing data":               {frame("exec.cancel", `{"stepId":"`+uuidB+`"}`) + "{}", CodeInvalidJSON},
		"not json":                    {`{"v":1,`, CodeInvalidJSON},
		"sql that writes":             {frame("probe.run", `{"stepId":"`+uuidB+`","probe":{"id":"p","origin":"agent","purpose":"x","expected":"y","compare":["db_count"],"spec":{"kind":"sql","target":{"service":"db","port":5432},"query":"delete from users","timeoutMs":100}}}`), CodeInvalidBody},
		"sql two statements":          {frame("probe.run", `{"stepId":"`+uuidB+`","probe":{"id":"p","origin":"agent","purpose":"x","expected":"y","compare":["db_count"],"spec":{"kind":"sql","target":{"service":"db","port":5432},"query":"select 1; drop table x","timeoutMs":100}}}`), CodeInvalidBody},
		"browser step with evaluate":  {frame("probe.run", `{"stepId":"`+uuidB+`","probe":{"id":"p","origin":"agent","purpose":"x","expected":"y","compare":["dom"],"spec":{"kind":"browser","viewport":{"width":800,"height":600},"timeoutMs":100,"steps":[{"evaluate":"document.cookie"}]}}}`), CodeInvalidBody},
		"tuple with extra item":       {frame("probe.run", `{"stepId":"`+uuidB+`","probe":{"id":"p","origin":"agent","purpose":"x","expected":"y","compare":["dom"],"spec":{"kind":"browser","viewport":{"width":800,"height":600},"timeoutMs":100,"steps":[{"fill":["#a","b","c"]}]}}}`), CodeInvalidBody},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Decode([]byte(c.frame))
			if err == nil {
				t.Fatal("decoded")
			}
			if got := codeOf(t, err); got != c.code {
				t.Fatalf("code %s, want %s (%v)", got, c.code, err)
			}
		})
	}
}

func TestDecodeFrameLimit(t *testing.T) {
	big := frame("step.stream", `{"stepId":"`+uuidB+`","chunk":"`+strings.Repeat("a", 2<<20)+`"}`)
	if code := codeOf(t, func() error { _, err := Decode([]byte(big)); return err }()); code != CodeFrameTooLarge {
		t.Fatalf("code %s", code)
	}
}

func TestDecodeDepthLimit(t *testing.T) {
	nest := func(n int) string {
		return strings.Repeat("[", n) + strings.Repeat("]", n)
	}
	// payload is unknown(): any value, so only the depth limit can refuse it.
	ok := `{"fake":"github","event":"push","payload":` + nest(29) + `}`
	body := func(p string) string {
		return `{"stepId":"` + uuidB + `","probe":{"id":"p","origin":"agent","purpose":"x","expected":"y","compare":["status"],"sendWebhook":` + p + `,"spec":{"kind":"http","target":{"service":"api","port":1},"method":"GET","path":"/","timeoutMs":1}}}`
	}
	if _, err := Decode([]byte(frame("probe.run", body(ok)))); err != nil {
		t.Fatalf("depth 32 refused: %v", err)
	}
	deep := `{"fake":"github","event":"push","payload":` + nest(30) + `}`
	if code := codeOf(t, func() error { _, err := Decode([]byte(frame("probe.run", body(deep)))); return err }()); code != CodeTooDeep {
		t.Fatalf("code %s", code)
	}
}

func TestEncodeRoundTrip(t *testing.T) {
	m, err := Decode([]byte(frame("probe.run", httpProbeRun)))
	if err != nil {
		t.Fatal(err)
	}
	out, err := Encode(Header{ID: uuidB, CellID: "cell-1", ClaimID: "claim-1"}, m.Body)
	if err != nil {
		t.Fatal(err)
	}
	again, err := Decode(out)
	if err != nil {
		t.Fatal(err)
	}
	if again.Body.(*ProbeRunBody).Probe.Spec.HTTP.Method != HTTPMethodGet {
		t.Fatal("method lost")
	}
}

func TestEncodeRefusesInvalidBody(t *testing.T) {
	// A required array left nil marshals as null; the self-check catches it.
	_, err := Encode(Header{ID: uuidA, CellID: "c"}, &HeartbeatBody{FreeSlots: 1})
	if err == nil {
		t.Fatal("encoded a heartbeat with claims: null")
	}
	if _, err := Encode(Header{ID: uuidA, CellID: "c"}, &HeartbeatBody{Claims: []HeartbeatClaim{}, FreeSlots: 1}); err != nil {
		t.Fatal(err)
	}
}

func TestEverySchemaCompiles(t *testing.T) {
	all, err := schemas()
	if err != nil {
		t.Fatal(err)
	}
	for _, typ := range []string{"envelope", "hello", "step.result", "egress.blocked"} {
		if all[typ] == nil {
			t.Fatalf("missing %s", typ)
		}
	}
}

// A number longer than 64 characters reads whole, as the TS decoder reads
// it (it used to be cut and refused as trailing junk).
func TestDecodeReadsLongNumbersWhole(t *testing.T) {
	long := "1" + strings.Repeat("0", 70)
	_, err := Decode([]byte(frame("heartbeat", `{"claims":[],"freeSlots":`+long+`}`)))
	if err == nil {
		t.Fatal("decoded a freeSlots past 2^53")
	}
	if got := codeOf(t, err); got != CodeInvalidBody {
		t.Fatalf("code %s, want invalid_body (the number parsed whole): %v", got, err)
	}
}

// The rules beyond the schema leave valid frames alone.
func TestDecodeAcceptsConsistentFrames(t *testing.T) {
	for name, f := range map[string]string{
		"setup claim held":    frame("claim.acquire", acquireJSON),
		"observer with probe": frame("step.result", `{"stepId":"`+uuidB+`","executor":"observer","imageId":"i","vmHealth":"ok","probe":`+probeResultJSON+`}`),
		"vm with exec":        frame("step.result", `{"stepId":"`+uuidB+`","executor":"vm","imageId":"i","vmHealth":"ok","exec":`+execResultJSON+`}`),
		"vm with neither":     frame("step.result", `{"stepId":"`+uuidB+`","executor":"vm","imageId":"i","vmHealth":"ok","durationMs":5}`),
		"ack with re":         strings.Replace(frame("ack", `{}`), `"claimId":"claim-1"`, `"re":"`+uuidB+`"`, 1),
	} {
		if _, err := Decode([]byte(f)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}
