// Package telemetry is the cell's side of the Runtime telemetry taxonomy
// (docs/runtime/observability.md): OpenTelemetry traces exported like the TS
// processes (OTLP over HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set, nothing
// otherwise), the W3C trace context a hub frame carries, and the slog handler
// that writes every line with the taxonomy's field names, the active trace
// and span ids, and no secret-shaped text.
//
// taxonomy.json is a byte-identical copy of libs/runtime/telemetry/taxonomy.json
// (TestTaxonomyFileMatchesTS): one decision for TS and Go.
package telemetry

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

//go:embed taxonomy.json
var taxonomyJSON []byte

// TaxonomyJSON is the embedded taxonomy file.
func TaxonomyJSON() []byte { return taxonomyJSON }

// The attribute keys the cell sets on spans and log lines (taxonomy.json).
const (
	OrganizationID = "kodus.organization.id"
	EnvironmentID  = "kodus.runtime.environment.id"
	RunID          = "kodus.runtime.run.id"
	ClaimID        = "kodus.runtime.claim.id"
	ClaimSide      = "kodus.runtime.claim.side"
	ClaimConsumer  = "kodus.runtime.claim.consumer"
	StepID         = "kodus.runtime.step.id"
	StepKind       = "kodus.runtime.step.kind"
	CellID         = "kodus.runtime.cell.id"
	Driver         = "kodus.runtime.driver"
	// TraceID and SpanID are the log fields of the active span, named as the
	// product's and the TS Runtime's logs name them.
	TraceID = "traceId"
	SpanID  = "spanId"
)

type taxonomyFile struct {
	Attributes map[string]struct {
		Cardinality string   `json:"cardinality"`
		Aliases     []string `json:"aliases"`
	} `json:"attributes"`
}

var taxonomy = func() taxonomyFile {
	var t taxonomyFile
	if err := json.Unmarshal(taxonomyJSON, &t); err != nil {
		panic(fmt.Sprintf("telemetry: taxonomy.json: %v", err))
	}
	return t
}()

// aliases maps an older field name (claim, run, cell, ...) to its taxonomy key.
var aliases = func() map[string]string {
	out := map[string]string{}
	for key, a := range taxonomy.Attributes {
		for _, alias := range a.Aliases {
			out[alias] = key
		}
	}
	return out
}()

// attributeKeys are the taxonomy's attribute keys: the only ones a span keeps.
var attributeKeys = func() map[string]struct{} {
	out := map[string]struct{}{}
	for key := range taxonomy.Attributes {
		out[key] = struct{}{}
	}
	return out
}()

// CanonicalKey is the taxonomy key of a log field name: an alias becomes its
// attribute, anything else stays.
func CanonicalKey(key string) string {
	if c, ok := aliases[key]; ok {
		return c
	}
	return key
}

// Tracer is the cell's tracer (the global provider Setup installs).
func Tracer() trace.Tracer { return otel.Tracer("kody-runtime-cell") }

// Setup installs the W3C propagator and a tracer provider for service. Spans
// are exported over OTLP/HTTP only when OTEL_EXPORTER_OTLP_ENDPOINT is set
// (the standard OTEL_* variables configure it, as on the TS side); without it
// spans still get ids, so log lines carry them, and nothing leaves the host.
// Every exported span goes through the redacting exporter first.
func Setup(ctx context.Context, service string) (func(context.Context) error, error) {
	otel.SetTextMapPropagator(propagation.TraceContext{})
	name := os.Getenv("OTEL_SERVICE_NAME")
	if name == "" {
		name = service
	}
	opts := []sdktrace.TracerProviderOption{
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", name))),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.AlwaysSample())),
	}
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") != "" {
		exp, err := otlptracehttp.New(ctx)
		if err != nil {
			return nil, fmt.Errorf("telemetry: otlp exporter: %w", err)
		}
		opts = append(opts, sdktrace.WithBatcher(&RedactingExporter{Next: exp}))
	}
	tp := sdktrace.NewTracerProvider(opts...)
	otel.SetTracerProvider(tp)
	return tp.Shutdown, nil
}

var traceparentShape = regexp.MustCompile(`^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$`)

// Remote is ctx with the remote parent a valid traceparent names; ctx
// unchanged for an absent or invalid one (the frame's decoder already
// refused a malformed one).
func Remote(ctx context.Context, traceparent *string) context.Context {
	if traceparent == nil || !traceparentShape.MatchString(*traceparent) {
		return ctx
	}
	return propagation.TraceContext{}.Extract(ctx, propagation.MapCarrier{"traceparent": *traceparent})
}

// Traceparent is the W3C traceparent of ctx's span, "" when there is none.
func Traceparent(ctx context.Context) string {
	if !trace.SpanContextFromContext(ctx).IsValid() {
		return ""
	}
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	return carrier["traceparent"]
}

// LogIDs are the log fields of ctx's span (traceId, spanId), none without one:
// a logger made With them carries the span on every line.
func LogIDs(ctx context.Context) []any {
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return nil
	}
	return []any{TraceID, sc.TraceID().String(), SpanID, sc.SpanID().String()}
}

// idShape is the value of an id attribute: what a claim id, a run id or a
// cell id looks like. Anything else is dropped from a span.
var idShape = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$`)

// ID is an id attribute, or the empty attribute (dropped by the exporter) when
// the value does not look like one.
func ID(key, value string) attribute.KeyValue {
	if !idShape.MatchString(value) || strings.HasPrefix(value, "kph_") {
		return attribute.KeyValue{}
	}
	return attribute.String(key, value)
}
