// Package protocol is the Go side of @kodus/runtime-protocol: the envelope,
// the message bodies (generated from the TS JSON Schema) and a decoder that
// refuses what the TS decoder refuses, with the same error codes.
package protocol

//go:generate go run ./gen -in schema/protocol.schema.json -out types_gen.go

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

//go:embed schema/protocol.schema.json
var schemaDoc []byte

type DecodeErrorCode string

const (
	CodeFrameTooLarge      DecodeErrorCode = "frame_too_large"
	CodeInvalidJSON        DecodeErrorCode = "invalid_json"
	CodeDuplicateKey       DecodeErrorCode = "duplicate_key"
	CodeTooDeep            DecodeErrorCode = "too_deep"
	CodeInvalidEnvelope    DecodeErrorCode = "invalid_envelope"
	CodeUnsupportedVersion DecodeErrorCode = "unsupported_version"
	CodeInvalidBody        DecodeErrorCode = "invalid_body"
)

// DecodeError is what the receiver turns into a nack (S-30).
type DecodeError struct {
	Code    DecodeErrorCode
	Message string
}

// ErrRefusedToSend marks a frame the cell's own encoder refused (it would
// not pass the schema): sending it again cannot succeed.
var ErrRefusedToSend = errors.New("protocol: refusing to send")

func (e *DecodeError) Error() string { return string(e.Code) + ": " + e.Message }

// SupportedVersions is the current version and the one before it (ADR-026).
func SupportedVersions() []int64 {
	if ProtocolVersion > 1 {
		return []int64{ProtocolVersion - 1, ProtocolVersion}
	}
	return []int64{ProtocolVersion}
}

var (
	compileOnce sync.Once
	compiled    map[string]*node
	compileErr  error
)

func schemas() (map[string]*node, error) {
	compileOnce.Do(func() {
		var doc struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		}
		if compileErr = json.Unmarshal(schemaDoc, &doc); compileErr != nil {
			return
		}
		compiled = map[string]*node{}
		for k, raw := range doc.Schemas {
			n, err := compileSchema(raw)
			if err != nil {
				compileErr = fmt.Errorf("schema %s: %w", k, err)
				return
			}
			compiled[k] = n
		}
	})
	return compiled, compileErr
}

// Message is a decoded frame: the envelope and a pointer to the typed body
// (*ClaimAcquireBody, *ProbeRunBody, ...).
type Message struct {
	Envelope Envelope
	Body     any
}

// Decode validates one WebSocket frame. Every error is a *DecodeError.
func Decode(frame []byte) (*Message, error) {
	if len(frame) > MaxFrameBytes {
		return nil, &DecodeError{CodeFrameTooLarge, fmt.Sprintf("%d bytes", len(frame))}
	}
	tree, err := parseStrict(string(frame), MaxDepth)
	if err != nil {
		return nil, err
	}
	all, err := schemas()
	if err != nil {
		return nil, err
	}
	if err := all["envelope"].validate(tree, ""); err != nil {
		return nil, &DecodeError{CodeInvalidEnvelope, err.Error()}
	}
	obj := tree.(map[string]any)

	var env Envelope
	if err := json.Unmarshal(frame, &env); err != nil {
		return nil, &DecodeError{CodeInvalidEnvelope, err.Error()}
	}
	supported := false
	for _, v := range SupportedVersions() {
		if env.V == v {
			supported = true
		}
	}
	if !supported {
		return nil, &DecodeError{CodeUnsupportedVersion, fmt.Sprintf("v%d", env.V)}
	}

	bodySchema, ok := all[string(env.Type)]
	if !ok {
		return nil, &DecodeError{CodeInvalidEnvelope, "unknown type " + string(env.Type)}
	}
	if missing := missingEnvelopeField(env); missing != "" {
		return nil, &DecodeError{CodeInvalidEnvelope, fmt.Sprintf("%s needs %s", env.Type, missing)}
	}
	if err := bodySchema.validate(obj["body"], "body"); err != nil {
		return nil, &DecodeError{CodeInvalidBody, err.Error()}
	}
	body, _ := newBody(env.Type)
	if err := json.Unmarshal(env.Body, body); err != nil {
		return nil, &DecodeError{CodeInvalidBody, err.Error()}
	}
	if err := refine(body); err != nil {
		return nil, &DecodeError{CodeInvalidBody, err.Error()}
	}
	return &Message{Envelope: env, Body: body}, nil
}

// ClaimScopedTypes act on one claim: the envelope must name it (claimId).
// Mirrors CLAIM_SCOPED_TYPES in envelope.ts.
var ClaimScopedTypes = map[MessageType]bool{
	MessageTypeClaimAcquire: true, MessageTypeClaimReady: true, MessageTypeClaimFailed: true,
	MessageTypeClaimRenew: true, MessageTypeClaimRelease: true, MessageTypeProbeRun: true,
	MessageTypeExec: true, MessageTypeUpload: true, MessageTypeExecCancel: true,
	MessageTypeMachineReset: true, MessageTypeStepResult: true, MessageTypeStepStream: true,
	MessageTypeEgressPolicy: true, MessageTypeClaimProgress: true, MessageTypeBrowserExplore: true,
}

// ReplyTypes answer another message: the envelope must name it (re).
var ReplyTypes = map[MessageType]bool{MessageTypeAck: true, MessageTypeNack: true}

// missingEnvelopeField is the envelope field a type requires beyond the
// schema ("" when none is missing), as missingEnvelopeField in envelope.ts.
func missingEnvelopeField(env Envelope) string {
	if ClaimScopedTypes[env.Type] && (env.ClaimID == nil || *env.ClaimID == "") {
		return "claimId"
	}
	if ReplyTypes[env.Type] && (env.Re == nil || *env.Re == "") {
		return "re"
	}
	// blocked answers a request (re), or reports on one claim unsolicited (claimId).
	if env.Type == MessageTypeBlocked && (env.Re == nil || *env.Re == "") && (env.ClaimID == nil || *env.ClaimID == "") {
		return "claimId"
	}
	return ""
}

// zod refinements do not survive toJSONSchema; these mirror the .refine and
// .superRefine calls of probe.schema.ts and messages.ts.
var (
	readOnlySQL  = regexp.MustCompile(`(?i)^\s*(select|with|explain|show)\b`)
	multiStmtSQL = regexp.MustCompile(`;\s*\S`)
	// SecurityViolationSignature mirrors SECURITY_VIOLATION_SIGNATURE (libs/runtime/contracts/enums.ts).
	SecurityViolationSignature = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

func refine(body any) error {
	switch b := body.(type) {
	case *BrowserExploreBody:
		return refineBrowserExploreRequest(b.Request)
	case *ProbeRunBody:
		if b.Probe.Spec.SQL != nil {
			return CheckReadOnlySQL(b.Probe.Spec.SQL.Query)
		}
	case *ClaimAcquireBody:
		if b.DiagnosticHold != nil && *b.DiagnosticHold && b.Consumer != ConsumerSetup {
			return fmt.Errorf("diagnosticHold: only a setup claim may ask for a diagnostic hold")
		}
		if b.SeedsCache != nil && *b.SeedsCache && (b.Consumer != ConsumerSetup || b.Side == SidePr) {
			return fmt.Errorf("seedsCache: only a setup claim that is not a PR may seed the build cache")
		}
		return refineRecipe(b.Recipe)
	case *StepResultBody:
		return checkStepResult(b)
	case *BlockedBody:
		if b.Kind == BlockerKindSecurityViolation && !SecurityViolationSignature.MatchString(b.Signature) {
			return fmt.Errorf("signature: a security_violation signature is the alert kind (lower snake case, at most 64 characters)")
		}
	}
	return nil
}

// checkStepResult: a probe result comes from the observer, an exec result
// from the VM, never both.
func checkStepResult(b *StepResultBody) error {
	if b.BrowserExploration != nil {
		if b.Exec != nil || b.Probe != nil || b.Executor != ExecutorObserver {
			return fmt.Errorf("browserExploration: exploration is an exclusive observer result")
		}
		return refineBrowserExploreResult(*b.BrowserExploration)
	}
	switch {
	case b.Probe != nil && b.Exec != nil:
		return fmt.Errorf("exec: a step result carries a probe or an exec result, not both")
	case b.Probe != nil && b.Executor != ExecutorObserver:
		return fmt.Errorf("executor: a probe result comes from the observer")
	case b.Exec != nil && b.Executor != ExecutorVM:
		return fmt.Errorf("executor: an exec result comes from the VM")
	}
	return nil
}

// BrowserSelectorProblem mirrors browserSelectorProblem in browser-exploration.ts.
// Parsing valid CSS is additionally required in the browser before native use.
func BrowserSelectorProblem(value string) bool {
	value = strings.TrimSpace(value)
	return ephemeralBrowserRef.MatchString(value) || strings.Contains(value, ">>") || browserSelectorEngine.MatchString(value)
}

var ephemeralBrowserRef = regexp.MustCompile(`^@e[0-9]+$`)
var browserSelectorEngine = regexp.MustCompile(`(?i)^(?:internal:|[A-Za-z_][A-Za-z0-9_-]*\s*=|//|\.//|\(\s*//)`)

func refineBrowserExploreRequest(r BrowserExploreRequest) error {
	if len(r.Steps) == 0 || r.Steps[0].Goto == nil {
		return fmt.Errorf("steps: exploration starts with goto")
	}
	for _, step := range r.Steps {
		var selector *string
		switch {
		case step.Click != nil:
			selector = step.Click
		case len(step.Fill) > 0:
			selector = &step.Fill[0]
		case len(step.Select) > 0:
			selector = &step.Select[0]
		case step.WaitFor != nil:
			selector = step.WaitFor
		}
		if selector != nil && BrowserSelectorProblem(*selector) {
			return fmt.Errorf("steps: exploration requires a stable CSS selector")
		}
	}
	return nil
}

func refineBrowserExploreResult(r BrowserExploreResult) error {
	for _, candidate := range r.Candidates {
		if BrowserSelectorProblem(candidate.Selector) {
			return fmt.Errorf("candidates: exploration requires a stable CSS selector")
		}
	}
	return nil
}

// validateExploreValue also checks the generated schema when a runner result
// did not arrive through Decode. Neither a local process nor a typed Go value
// may bypass the wire's bounds.
func validateExploreValue(message, property string, value any) error {
	all, err := schemas()
	if err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tree, err := parseStrict(string(raw), MaxDepth)
	if err != nil {
		return err
	}
	return all[message].Properties[property].validate(tree, property)
}

// CheckBrowserExploreRequest holds a local request to the wire schema and refinements.
func CheckBrowserExploreRequest(r BrowserExploreRequest) error {
	if err := validateExploreValue("browser.explore", "request", r); err != nil {
		return err
	}
	return refineBrowserExploreRequest(r)
}

// CheckBrowserExploreResult holds a local runner result to the wire's bounds.
func CheckBrowserExploreResult(r BrowserExploreResult) error {
	if err := validateExploreValue("step.result", "browserExploration", r); err != nil {
		return err
	}
	return refineBrowserExploreResult(r)
}

// CheckReadOnlySQL is the same rule as SqlProbeSchema's refinements.
func CheckReadOnlySQL(q string) error {
	if !readOnlySQL.MatchString(q) {
		return fmt.Errorf("probe.spec.query: sql probes are read-only: SELECT, WITH, EXPLAIN or SHOW")
	}
	if multiStmtSQL.MatchString(q) {
		return fmt.Errorf("probe.spec.query: sql probes run a single statement")
	}
	return nil
}

// Header is the part of the envelope the sender chooses.
type Header struct {
	ID      string
	Re      string
	CellID  string
	ClaimID string
}

// Encode builds a frame and runs it back through Decode, so the cell never
// sends a frame the hub would refuse.
func Encode(h Header, body any) ([]byte, error) {
	t, ok := bodyType(body)
	if !ok {
		return nil, fmt.Errorf("protocol: %T is not a message body", body)
	}
	rawBody, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	env := Envelope{V: ProtocolVersion, ID: h.ID, CellID: h.CellID, Type: t, Body: rawBody}
	if h.Re != "" {
		env.Re = &h.Re
	}
	if h.ClaimID != "" {
		env.ClaimID = &h.ClaimID
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(env); err != nil {
		return nil, err
	}
	frame := bytes.TrimRight(buf.Bytes(), "\n")
	if _, err := Decode(frame); err != nil {
		return nil, fmt.Errorf("%w %s: %w", ErrRefusedToSend, t, err)
	}
	return frame, nil
}
