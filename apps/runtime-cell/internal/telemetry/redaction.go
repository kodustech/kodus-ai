package telemetry

import (
	"context"
	"log/slog"
	"regexp"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// The redaction rule of Runtime telemetry, the Go half of
// libs/runtime/telemetry/telemetry-guard.ts: no secret value, placeholder,
// canary or token reaches a log line or a span. Log fields are free but every
// string is scrubbed and sensitive keys dropped; span attributes are the
// taxonomy's only.

// shapes are secret by shape, beyond the shared token rules: the cell's
// placeholder (policy.PlaceholderPrefix), the Run's canaries, a Team CLI key,
// a bearer credential, a JWT, a URL with a user and password
// (protocol.TelemetrySecretShapes, generated from the TS guard's).
var shapes = func() []shape {
	out := make([]shape, 0, len(protocol.TelemetrySecretShapes))
	for _, s := range protocol.TelemetrySecretShapes {
		out = append(out, shape{s.ID, regexp.MustCompile(s.Pattern)})
	}
	return out
}()

type shape struct {
	id string
	re *regexp.Regexp
}

// Scrub is s with every secret-shaped part replaced by [redacted:<rule>],
// bounded to 2 KiB; changed reports whether anything was replaced.
func Scrub(s string) (out string, changed bool) {
	if len(s) > 2048 {
		s = s[:2048]
	}
	for _, sh := range shapes {
		if sh.re.MatchString(s) {
			s = sh.re.ReplaceAllString(s, redact.Marker(sh.id))
			changed = true
		}
	}
	if r, n := redact.Patterns(s); n > 0 {
		s, changed = r, true
	}
	return s, changed
}

// sensitiveKey is a field name whose value is never logged, whatever it is.
var sensitiveKey = regexp.MustCompile(`(?i)token|password|authorization|cookie|private.?key|api.?key|placeholder|canar(y|ies)|^value$|^secretValue$|stdout|stderr|^body$|^headers?$|^command$`)

// Handler writes every record through next with the taxonomy's field names
// (claim → kodus.runtime.claim.id), the active span's traceId and spanId, and
// every string scrubbed (Scrub); a sensitive key is dropped.
type Handler struct{ next slog.Handler }

// NewHandler wraps next.
func NewHandler(next slog.Handler) *Handler { return &Handler{next: next} }

func (h *Handler) Enabled(ctx context.Context, l slog.Level) bool { return h.next.Enabled(ctx, l) }

func (h *Handler) Handle(ctx context.Context, r slog.Record) error {
	msg, _ := Scrub(r.Message)
	out := slog.NewRecord(r.Time, r.Level, msg, r.PC)
	hasTrace := false
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == TraceID {
			hasTrace = true
		}
		if c, ok := clean(a); ok {
			out.AddAttrs(c)
		}
		return true
	})
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() && !hasTrace {
		out.AddAttrs(slog.String(TraceID, sc.TraceID().String()), slog.String(SpanID, sc.SpanID().String()))
	}
	return h.next.Handle(ctx, out)
}

func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	kept := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		if c, ok := clean(a); ok {
			kept = append(kept, c)
		}
	}
	return &Handler{next: h.next.WithAttrs(kept)}
}

func (h *Handler) WithGroup(name string) slog.Handler { return &Handler{next: h.next.WithGroup(name)} }

// clean is one field as a log line may carry it, or false (dropped).
func clean(a slog.Attr) (slog.Attr, bool) {
	if sensitiveKey.MatchString(a.Key) {
		return slog.Attr{}, false
	}
	a.Key = CanonicalKey(a.Key)
	v := a.Value.Resolve()
	if v.Kind() == slog.KindString {
		s, _ := Scrub(v.String())
		return slog.String(a.Key, s), true
	}
	if v.Kind() == slog.KindGroup {
		var group []any
		for _, g := range v.Group() {
			if c, ok := clean(g); ok {
				group = append(group, c)
			}
		}
		return slog.Group(a.Key, group...), true
	}
	if v.Kind() == slog.KindAny {
		switch x := v.Any().(type) {
		case error:
			s, _ := Scrub(x.Error())
			return slog.String(a.Key, s), true
		case []string:
			out := make([]string, len(x))
			for i, s := range x {
				out[i], _ = Scrub(s)
			}
			return slog.Any(a.Key, out), true
		case fmtStringer:
			s, _ := Scrub(x.String())
			return slog.String(a.Key, s), true
		}
	}
	return slog.Attr{Key: a.Key, Value: v}, true
}

type fmtStringer interface{ String() string }

// spanKeys are the span attributes outside the taxonomy that may stay.
var spanKeys = map[string]bool{"exception.type": true}

// RedactingExporter is the last gate before a span leaves the cell: only
// taxonomy attributes whose string values carry nothing secret-shaped, event
// attributes the same, links the same, and no status message.
type RedactingExporter struct{ Next sdktrace.SpanExporter }

func (e *RedactingExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	out := make([]sdktrace.ReadOnlySpan, 0, len(spans))
	for _, s := range spans {
		stub := tracetest.SpanStubFromReadOnlySpan(s)
		stub.Name, _ = Scrub(stub.Name)
		stub.Attributes = spanAttributes(stub.Attributes)
		for i := range stub.Events {
			stub.Events[i].Attributes = spanAttributes(stub.Events[i].Attributes)
		}
		for i := range stub.Links {
			stub.Links[i].Attributes = spanAttributes(stub.Links[i].Attributes)
		}
		stub.Status = sdktrace.Status{Code: stub.Status.Code}
		if stub.Status.Code == codes.Unset {
			stub.Status = sdktrace.Status{}
		}
		out = append(out, stub.Snapshot())
	}
	return e.Next.ExportSpans(ctx, out)
}

func (e *RedactingExporter) Shutdown(ctx context.Context) error { return e.Next.Shutdown(ctx) }

func spanAttributes(in []attribute.KeyValue) []attribute.KeyValue {
	out := make([]attribute.KeyValue, 0, len(in))
	for _, kv := range in {
		key := CanonicalKey(string(kv.Key))
		if _, ok := attributeKeys[key]; !ok && !spanKeys[key] {
			continue
		}
		if kv.Value.Type() == attribute.STRING {
			if _, changed := Scrub(kv.Value.AsString()); changed {
				continue
			}
		}
		out = append(out, attribute.KeyValue{Key: attribute.Key(key), Value: kv.Value})
	}
	return out
}
