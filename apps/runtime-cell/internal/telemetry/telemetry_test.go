package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// Samples of every secret shape the Runtime handles; none is a real credential.
var secrets = []string{
	"kph_abcdefghijklmnopqrstuvwxyz234567",
	"npm_0123456789abcdef0123456789abcdef",
	"kdx_live_0123456789abcdef0123456789abcdef",
	"ghs_EXAMPLE0EXAMPLE0EXAMPLE0EXAMPLE0EXAM",
	"glpat-EXAMPLE0EXAMPLE0EXAM",
	"AKIAIOSFODNN7EXAMPLE",
	"kodus_0123456789abcdef0123456789",
	"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
	"Bearer example0example0example0example0",
	"https://deploy:hunter2-example@registry.example.test/v2/",
}

func leaked(t *testing.T, out string) {
	t.Helper()
	for _, s := range secrets {
		if strings.Contains(out, s) || strings.Contains(out, strings.TrimPrefix(s, "Bearer ")) {
			t.Errorf("leaked %q in:\n%s", s, out)
		}
	}
}

func TestTaxonomyFileMatchesTS(t *testing.T) {
	ts, err := os.ReadFile("../../../../libs/runtime/telemetry/taxonomy.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ts, taxonomyJSON) {
		t.Fatal("taxonomy.json differs from libs/runtime/telemetry/taxonomy.json: copy it over")
	}
}

func TestNoSecretReachesALogLine(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(NewHandler(slog.NewJSONHandler(&buf, nil)))
	for _, s := range secrets {
		log.With("claim", s, "note", "with "+s).Info("boot failed near "+s, "err", errors.New("dial "+s), "reason", s, "hosts", []string{s}, "token", "plain", "detail", slog.GroupValue(slog.String("why", s)))
	}
	leaked(t, buf.String())
	if strings.Contains(buf.String(), `"token"`) {
		t.Fatal("a sensitive key was written")
	}
}

func TestALogLineCarriesTheTaxonomyKeysAndTheActiveSpan(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(NewHandler(slog.NewJSONHandler(&buf, nil))).With("cell", "cell-a", "claim", "claim-1", "run", "run-1")
	tp := sdktrace.NewTracerProvider()
	ctx := Remote(context.Background(), ptr("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"))
	ctx, span := tp.Tracer("t").Start(ctx, "cell.claim.acquire")
	defer span.End()
	log.InfoContext(ctx, "claim.acquire", "side", "pr")
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{
		CellID: "cell-a", ClaimID: "claim-1", RunID: "run-1", ClaimSide: "pr",
		TraceID: "0af7651916cd43dd8448eb211c80319c", SpanID: span.SpanContext().SpanID().String(),
	} {
		if line[k] != want {
			t.Errorf("%s = %v, want %s (line %s)", k, line[k], want, buf.String())
		}
	}
	for _, old := range []string{"cell", "claim", "run", "side"} {
		if _, ok := line[old]; ok {
			t.Errorf("the older key %q is still written", old)
		}
	}
}

func TestNoSecretReachesASpan(t *testing.T) {
	mem := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(&RedactingExporter{Next: mem}))
	for _, s := range secrets {
		_, span := tp.Tracer("t").Start(context.Background(), "step "+s)
		span.SetAttributes(attribute.String(ClaimID, s), attribute.String("free.text", s), attribute.String("claim", s), attribute.String(StepKind, "probe.run"))
		span.AddEvent("exception", trace.WithAttributes(attribute.String("exception.message", s), attribute.String("exception.type", s)))
		span.SetStatus(codes.Error, s)
		span.End()
	}
	out, _ := json.Marshal(mem.GetSpans())
	leaked(t, string(out))
	if got := len(mem.GetSpans()); got != len(secrets) {
		t.Fatalf("exported %d spans, want %d", got, len(secrets))
	}
	for _, s := range mem.GetSpans() {
		if len(s.Attributes) != 1 || s.Attributes[0].Key != StepKind {
			t.Fatalf("kept %v, want only %s", s.Attributes, StepKind)
		}
	}
}

func TestARemoteParentBecomesTheSpanParentAndGoesOn(t *testing.T) {
	tp := sdktrace.NewTracerProvider()
	parent := "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	ctx, span := tp.Tracer("t").Start(Remote(context.Background(), &parent), "cell.step")
	defer span.End()
	if got := span.SpanContext().TraceID().String(); got != "0af7651916cd43dd8448eb211c80319c" {
		t.Fatalf("trace %s", got)
	}
	next := Traceparent(ctx)
	if !strings.HasPrefix(next, "00-0af7651916cd43dd8448eb211c80319c-") || strings.Contains(next, "b7ad6b7169203331") {
		t.Fatalf("the guest would get %q", next)
	}
	if Traceparent(Remote(context.Background(), ptr("junk"))) != "" || Traceparent(context.Background()) != "" {
		t.Fatal("an invalid or absent traceparent made a trace")
	}
}

func ptr(s string) *string { return &s }
