// Command gen writes types_gen.go from the JSON Schema that
// libs/runtime/protocol exports (protocolJsonSchemas). The TS side is the
// source of truth: change the zod schema, dump it again, run go generate.
//
//	ts-node -r tsconfig-paths/register --transpile-only libs/runtime/protocol/scripts/dump-json-schema.ts
//	cd apps/runtime-cell && go generate ./internal/protocol
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"go/format"
	"log"
	"os"
	"strings"
	"unicode"
)

type prop struct {
	name   string
	schema *schema
}

type schema struct {
	Type        string
	Properties  []prop
	Required    map[string]bool
	Additional  *schema // additionalProperties as a schema (records)
	Enum        []string
	Const       *string
	AnyOf       []*schema
	Items       *schema
	PrefixItems []*schema
	raw         string
}

// orderedKeys returns the keys of a JSON object in document order.
func orderedKeys(raw json.RawMessage) []string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	var keys []string
	depth := 0
	expectKey := false
	for {
		tok, err := dec.Token()
		if err != nil {
			return keys
		}
		switch t := tok.(type) {
		case json.Delim:
			switch t {
			case '{':
				depth++
				expectKey = depth == 1
				continue
			case '[':
				depth++
			case '}', ']':
				depth--
			}
			expectKey = depth == 1
		case string:
			if depth == 1 && expectKey {
				keys = append(keys, t)
				expectKey = false
				continue
			}
			expectKey = depth == 1
		default:
			expectKey = depth == 1
		}
	}
}

// must stops the generator on a schema it cannot read: a malformed dump
// never becomes wrong Go types quietly.
func must(what string, err error) {
	if err != nil {
		log.Fatalf("schema %s: %v", what, err)
	}
}

func parse(raw json.RawMessage) *schema {
	var m map[string]json.RawMessage
	must("object", json.Unmarshal(raw, &m))
	// Shapes are compared compact, so the same schema at two depths of the
	// dump (different indentation) is one Go type.
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		log.Fatalf("schema: %v", err)
	}
	s := &schema{Required: map[string]bool{}, raw: compact.String()}
	if v, ok := m["type"]; ok {
		must("type", json.Unmarshal(v, &s.Type))
	}
	if v, ok := m["properties"]; ok {
		var props map[string]json.RawMessage
		must("properties", json.Unmarshal(v, &props))
		for _, k := range orderedKeys(v) {
			s.Properties = append(s.Properties, prop{k, parse(props[k])})
		}
	}
	if v, ok := m["required"]; ok {
		var req []string
		must("required", json.Unmarshal(v, &req))
		for _, r := range req {
			s.Required[r] = true
		}
	}
	if v, ok := m["additionalProperties"]; ok && len(v) > 0 && v[0] == '{' {
		s.Additional = parse(v)
	}
	if v, ok := m["enum"]; ok {
		must("enum", json.Unmarshal(v, &s.Enum))
	}
	if v, ok := m["const"]; ok {
		var c string
		if json.Unmarshal(v, &c) == nil {
			s.Const = &c
		}
	}
	if v, ok := m["anyOf"]; ok {
		var list []json.RawMessage
		must("anyOf", json.Unmarshal(v, &list))
		for _, x := range list {
			s.AnyOf = append(s.AnyOf, parse(x))
		}
	}
	if v, ok := m["items"]; ok && len(v) > 0 && v[0] == '{' {
		s.Items = parse(v)
	}
	if v, ok := m["prefixItems"]; ok {
		var list []json.RawMessage
		must("prefixItems", json.Unmarshal(v, &list))
		for _, x := range list {
			s.PrefixItems = append(s.PrefixItems, parse(x))
		}
	}
	return s
}

var initialisms = map[string]string{
	"id": "ID", "url": "URL", "http": "HTTP", "sql": "SQL", "sni": "SNI",
	"dom": "DOM", "vm": "VM", "json": "JSON", "uuid": "UUID", "api": "API",
}

// pascal turns "claim.acquire", "stepId" or "custom_agent" into a Go name.
func pascal(s string) string {
	var words []string
	cur := []rune{}
	flush := func() {
		if len(cur) > 0 {
			words = append(words, string(cur))
			cur = cur[:0]
		}
	}
	runes := []rune(s)
	for i, r := range runes {
		switch {
		case !unicode.IsLetter(r) && !unicode.IsDigit(r):
			flush()
		case unicode.IsUpper(r) && i > 0 && unicode.IsLower(runes[i-1]):
			flush()
			cur = append(cur, r)
		default:
			cur = append(cur, r)
		}
	}
	flush()
	var b strings.Builder
	for _, w := range words {
		if up, ok := initialisms[strings.ToLower(w)]; ok {
			b.WriteString(up)
			continue
		}
		if strings.ToUpper(w) == w && len(w) > 1 {
			b.WriteString(w[:1] + strings.ToLower(w[1:]))
			continue
		}
		b.WriteString(strings.ToUpper(w[:1]) + w[1:])
	}
	return b.String()
}

// Names for the types people read; everything else is derived from the path.
// main copies it and adds the body names; the table itself never changes.
var typeNames = map[string]string{
	"envelope":                                    "Envelope",
	"envelope/type":                               "MessageType",
	"hello/isolation":                             "Isolation",
	"hello/owner":                                 "CellOwner",
	"claim.acquire/side":                          "Side",
	"claim.acquire/consumer":                      "Consumer",
	"claim.acquire/expose[]":                      "Expose",
	"claim.acquire/expose[]/kind":                 "ExposeKind",
	"browser.explore/request":                     "BrowserExploreRequest",
	"browser.explore/request/steps[]":             "BrowserExploreStep",
	"browser.explore/request/viewport":            "BrowserProbeViewport",
	"step.result/browserExploration":              "BrowserExploreResult",
	"step.result/browserExploration/status":       "BrowserExploreStatus",
	"step.result/browserExploration/candidates[]": "BrowserExploreCandidate",
	"probe.run/probe":                             "Probe",
	"probe.run/probe/spec":                        "ProbeSpec",
	"probe.run/probe/spec|http":                   "HTTPProbe",
	"probe.run/probe/spec|sql":                    "SQLProbe",
	"probe.run/probe/spec|browser":                "BrowserProbe",
	"probe.run/probe/spec|shell":                  "ShellProbe",
	"probe.run/probe/spec|http/target":            "ProbeTarget",
	"probe.run/probe/spec|http/method":            "HTTPMethod",
	"probe.run/probe/spec|browser/steps[]":        "BrowserStep",
	"probe.run/probe/compare[]":                   "CompareField",
	"probe.run/probe/origin":                      "ProbeOrigin",
	"probe.run/probe/evidence":                    "EvidenceLevel",
	"step.result/probe":                           "ProbeResult",
	"step.result/probe/requests[]":                "RequestLogEntry",
	"step.result/exec":                            "ExecResult",
	"step.result/executor":                        "Executor",
	"step.result/vmHealth":                        "VMHealth",
	"blocked/kind":                                "BlockerKind",
	"claim.failed/kind":                           "BlockerKind",
	"claim.acquire/repo":                          "RepoRef",
	"claim.acquire/repo/provider":                 "GitProvider",
	"claim.ready/manifest":                        "Manifest",
	"claim.ready/manifest/services[]":             "ManifestService",
	"claim.ready/manifest/services[]/health":      "ServiceHealth",
	"claim.ready/observer":                        "ObserverState",
	"claim.ready/timing":                          "ReadyTiming",
	"claim.ready/observer/state":                  "ObserverPhase",
	"egress.blocked/phase":                        "EgressPhase",
	"machine.reset/snapshot":                      "Snapshot",
	"upload/files[]":                              "UploadFile",
	"claim.acquire/recipe/files[]":                "AuthoredFile",
	"heartbeat/claims[]":                          "HeartbeatClaim",
	// Evidence capture (EVIDENCE-CAPTURE-DESIGN): one request shape for probe.run and exec.
	"probe.run/evidence":                          "EvidenceRequest",
	"probe.run/evidence/capture[]":                "EvidenceCapture",
	"probe.run/evidence/uploads[]":                "UploadGrant",
	"probe.run/evidence/uploads[]/type":           "EvidenceUploadType",
	"probe.run/evidence/uploads[]/contentType":    "EvidenceContentType",
	"step.result/exec/refs[]":                     "EvidenceRef",
	"step.result/probe/evidence":                  "ProbeEvidence",
	"step.result/probe/evidence/logs":             "ServiceLogsEvidence",
	"step.result/probe/evidence/logs/tail[]":      "ServiceLogLine",
	"step.result/probe/evidence/db":               "DBEffects",
	"step.result/probe/evidence/db/engine":        "DBEngine",
	"step.result/probe/evidence/db/tables[]":      "DBTableEffect",
	"step.result/probe/evidence/db/sample[]":      "DBSample",
	"step.result/probe/evidence/outbound":         "OutboundEvidence",
	"step.result/probe/evidence/outbound/calls[]": "OutboundCall",
	// Browser probes (ADR-071).
	"probe.run/evidence/baseline[]":           "BaselineScreenshot",
	"step.result/probe/browser":               "BrowserResult",
	"step.result/probe/browser/network[]":     "BrowserNetworkEntry",
	"step.result/probe/browser/console[]":     "BrowserConsoleEntry",
	"step.result/probe/browser/steps[]":       "BrowserStepOutcome",
	"step.result/probe/browser/steps[]/kind":  "BrowserStepKind",
	"step.result/probe/browser/steps[]/error": "BrowserStepError",
	"step.result/probe/browser/pixels[]":      "PixelDiff",
	// One machine size shape: what a claim asks and what a cell grants.
	"hello/maxClaimSize": "MachineSize",
	"claim.acquire/size": "MachineSize",
}

type gen struct {
	out       bytes.Buffer
	byShape   map[string]string
	used      map[string]string
	overrides map[string]string
}

func (g *gen) name(path, fallback string) string {
	if n, ok := g.overrides[path]; ok {
		return n
	}
	return fallback
}

func (g *gen) claim(name, raw string) {
	if prev, ok := g.used[name]; ok && prev != raw {
		log.Fatalf("type name %s used for two different schemas", name)
	}
	g.used[name] = raw
	g.byShape[raw] = name
}

func (g *gen) goType(s *schema, path, name string) string {
	if len(s.AnyOf) > 0 {
		return g.union(s, path, name)
	}
	switch s.Type {
	case "object":
		if len(s.Properties) == 0 && s.Additional != nil {
			return "map[string]" + g.goType(s.Additional, path+"{}", name+"Value")
		}
		return g.object(s, path, name)
	case "string":
		if len(s.Enum) > 0 {
			return g.enum(s, path, name)
		}
		return "string"
	case "integer":
		return "int64"
	case "number":
		return "float64"
	case "boolean":
		return "bool"
	case "array":
		if len(s.PrefixItems) > 0 {
			allStrings := true
			for _, p := range s.PrefixItems {
				if p.Type != "string" {
					allStrings = false
				}
			}
			if allStrings {
				return "[]string"
			}
			return "[]json.RawMessage"
		}
		if s.Items != nil {
			return "[]" + g.goType(s.Items, path+"[]", name+"Item")
		}
		return "[]json.RawMessage"
	}
	return "json.RawMessage"
}

func (g *gen) enum(s *schema, path, name string) string {
	if n, ok := g.byShape[s.raw]; ok {
		return n
	}
	name = g.name(path, name)
	g.claim(name, s.raw)
	fmt.Fprintf(&g.out, "type %s string\n\nconst (\n", name)
	for _, v := range s.Enum {
		fmt.Fprintf(&g.out, "\t%s%s %s = %q\n", name, pascal(v), name, v)
	}
	fmt.Fprintf(&g.out, ")\n\n")
	return name
}

func (g *gen) object(s *schema, path, name string) string {
	if n, ok := g.byShape[s.raw]; ok {
		return n
	}
	name = g.name(path, name)
	g.claim(name, s.raw)
	var fields bytes.Buffer
	for _, p := range s.Properties {
		fieldName := pascal(p.name)
		t := g.goType(p.schema, path+"/"+p.name, name+fieldName)
		tag := p.name
		if !s.Required[p.name] {
			tag += ",omitempty"
			if !strings.HasPrefix(t, "[]") && !strings.HasPrefix(t, "map[") && t != "json.RawMessage" {
				t = "*" + t
			}
		}
		fmt.Fprintf(&fields, "\t%s %s `json:%q`\n", fieldName, t, tag)
	}
	fmt.Fprintf(&g.out, "type %s struct {\n%s}\n\n", name, fields.String())
	return name
}

func (g *gen) union(s *schema, path, name string) string {
	if n, ok := g.byShape[s.raw]; ok {
		return n
	}
	name = g.name(path, name)
	// Discriminated by a "kind" const: a wrapper with one pointer per variant.
	kinds := []string{}
	for _, v := range s.AnyOf {
		var kind string
		for _, p := range v.Properties {
			if p.name == "kind" && p.schema.Const != nil {
				kind = *p.schema.Const
			}
		}
		if kind == "" {
			kinds = nil
			break
		}
		kinds = append(kinds, kind)
	}
	if kinds != nil {
		g.claim(name, s.raw)
		var variants []string
		for i, v := range s.AnyOf {
			vt := g.object(v, path+"|"+kinds[i], name+pascal(kinds[i]))
			variants = append(variants, vt)
		}
		var b bytes.Buffer
		fmt.Fprintf(&b, "// %s is a union discriminated by \"kind\"; exactly one field is set.\ntype %s struct {\n", name, name)
		for i, k := range kinds {
			fmt.Fprintf(&b, "\t%s *%s\n", pascal(k), variants[i])
		}
		fmt.Fprintf(&b, "}\n\n")
		fmt.Fprintf(&b, "// Kind returns the discriminator of the variant that is set.\nfunc (u %s) Kind() string {\n\tswitch {\n", name)
		for _, k := range kinds {
			fmt.Fprintf(&b, "\tcase u.%s != nil:\n\t\treturn %q\n", pascal(k), k)
		}
		fmt.Fprintf(&b, "\t}\n\treturn \"\"\n}\n\n")
		fmt.Fprintf(&b, "func (u %s) MarshalJSON() ([]byte, error) {\n\tswitch {\n", name)
		for _, k := range kinds {
			fmt.Fprintf(&b, "\tcase u.%s != nil:\n\t\tv := *u.%s\n\t\tv.Kind = %q\n\t\treturn json.Marshal(v)\n", pascal(k), pascal(k), k)
		}
		fmt.Fprintf(&b, "\t}\n\treturn nil, errors.New(\"%s: no variant set\")\n}\n\n", name)
		fmt.Fprintf(&b, "func (u *%s) UnmarshalJSON(b []byte) error {\n\tvar d struct {\n\t\tKind string `json:\"kind\"`\n\t}\n\tif err := json.Unmarshal(b, &d); err != nil {\n\t\treturn err\n\t}\n\t*u = %s{}\n\tswitch d.Kind {\n", name, name)
		for i, k := range kinds {
			fmt.Fprintf(&b, "\tcase %q:\n\t\tu.%s = new(%s)\n\t\treturn json.Unmarshal(b, u.%s)\n", k, pascal(k), variants[i], pascal(k))
		}
		fmt.Fprintf(&b, "\t}\n\treturn fmt.Errorf(\"%s: unknown kind %%q\", d.Kind)\n}\n\n", name)
		g.out.Write(b.Bytes())
		return name
	}
	// Objects with disjoint keys (browser steps): one struct, every field
	// optional; the schema check guarantees exactly one variant matched.
	merged := &schema{Type: "object", Required: map[string]bool{}, raw: s.raw}
	seen := map[string]bool{}
	for _, v := range s.AnyOf {
		if v.Type != "object" {
			return "json.RawMessage"
		}
		for _, p := range v.Properties {
			if seen[p.name] {
				return "json.RawMessage"
			}
			seen[p.name] = true
			merged.Properties = append(merged.Properties, p)
		}
	}
	return g.object(merged, path, name)
}

func main() {
	in := flag.String("in", "schema/protocol.schema.json", "schema dump")
	out := flag.String("out", "types_gen.go", "output file")
	flag.Parse()

	raw, err := os.ReadFile(*in)
	if err != nil {
		log.Fatal(err)
	}
	var doc struct {
		ProtocolVersion int                        `json:"protocolVersion"`
		MaxFrameBytes   int                        `json:"maxFrameBytes"`
		MaxDepth        int                        `json:"maxDepth"`
		Schemas         map[string]json.RawMessage `json:"schemas"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		log.Fatal(err)
	}
	var top map[string]json.RawMessage
	must("document", json.Unmarshal(raw, &top))
	schemasRaw := top["schemas"]

	g := &gen{byShape: map[string]string{}, used: map[string]string{}, overrides: map[string]string{}}
	for k, v := range typeNames {
		g.overrides[k] = v
	}
	g.goType(parse(doc.Schemas["envelope"]), "envelope", "Envelope")

	var types []string
	for _, k := range orderedKeys(schemasRaw) {
		if k != "envelope" {
			types = append(types, k)
		}
	}
	bodies := map[string]string{}
	for _, t := range types {
		s := parse(doc.Schemas[t])
		bodyName := pascal(t) + "Body"
		g.overrides[t] = bodyName
		// Empty bodies share a shape; give each message its own named type.
		if len(s.Properties) == 0 {
			g.claim(bodyName, s.raw+"#"+t)
			fmt.Fprintf(&g.out, "type %s struct{}\n\n", bodyName)
			bodies[t] = bodyName
			continue
		}
		bodies[t] = g.goType(s, t, bodyName)
	}

	var head bytes.Buffer
	fmt.Fprintf(&head, "// Code generated by internal/protocol/gen from schema/protocol.schema.json. DO NOT EDIT.\n\npackage protocol\n\n")
	fmt.Fprintf(&head, "import (\n\t\"encoding/json\"\n\t\"errors\"\n\t\"fmt\"\n)\n\n")
	fmt.Fprintf(&head, "const (\n\tProtocolVersion = %d\n\tMaxFrameBytes = %d\n\tMaxDepth = %d\n)\n\n", doc.ProtocolVersion, doc.MaxFrameBytes, doc.MaxDepth)

	var tail bytes.Buffer
	fmt.Fprintf(&tail, "// newBody returns a pointer to the typed body of a message type.\nfunc newBody(t MessageType) (any, bool) {\n\tswitch t {\n")
	for _, t := range types {
		fmt.Fprintf(&tail, "\tcase MessageType%s:\n\t\treturn new(%s), true\n", pascal(t), bodies[t])
	}
	fmt.Fprintf(&tail, "\t}\n\treturn nil, false\n}\n\n")
	fmt.Fprintf(&tail, "// bodyType maps a Go body type back to its message type.\nfunc bodyType(body any) (MessageType, bool) {\n\tswitch body.(type) {\n")
	for _, t := range types {
		fmt.Fprintf(&tail, "\tcase %s, *%s:\n\t\treturn MessageType%s, true\n", bodies[t], bodies[t], pascal(t))
	}
	fmt.Fprintf(&tail, "\t}\n\treturn \"\", false\n}\n")

	src := append(head.Bytes(), g.out.Bytes()...)
	src = append(src, tail.Bytes()...)
	formatted, err := format.Source(src)
	if err != nil {
		_ = os.WriteFile(*out, src, 0o644)
		log.Fatalf("format: %v", err)
	}
	if err := os.WriteFile(*out, formatted, 0o644); err != nil {
		log.Fatal(err)
	}
}
