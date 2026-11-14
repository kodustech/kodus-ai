// Package browser plays a browser probe (ADR-071) in the cell's browser
// runner: a Kodus image, pinned by digest, that a driver starts per probe
// round on the claim network (dockergvisor.BrowserRunner). It hands the
// runner the closed step list, reads back one tar stream, holds every
// artifact to the design's bound, scans the text ones with the claim's
// redactor, and diffs each screenshot against the baseline round's
// screenshot of the same step.
//
// Images and video cannot be redacted: the runner only ever sees the
// environment's seed data. Nothing here reads page script from the probe:
// the steps are checked against the closed list before the container starts
// and again in the runner (browser-runner/steps.mjs).
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// AppHost is the name the page reaches the app by; the runner resolves no
// other (Chromium host-resolver rules, and an /etc/hosts line the driver
// writes for it).
const AppHost = "app.kody.internal"

// The design table's bounds (EVIDENCE-CAPTURE-DESIGN "What is captured").
const (
	MaxScreenshots     = 10
	MaxScreenshotBytes = 2 << 20
	// Screenshot decode memory is bounded independently of compressed bytes.
	MaxScreenshotPixels = 4096 * 4096
	MaxVideoBytes       = 20 << 20
	MaxTraceBytes       = 20 << 20
	MaxHARBytes         = 10 << 20
	// MaxSession bounds the browser session, so the video is never longer.
	MaxSession = 60 * time.Second
	// MinSession is the shortest session the runner takes.
	MinSession = time.Second
	// StartGrace is what the container gets past the session to start
	// Chromium, close the context (the video and the HAR are written then)
	// and hand the artifacts over.
	StartGrace = 40 * time.Second

	maxResultBytes = 4 << 20
	maxValue       = 512
	maxStreamBytes = 128 << 20
	// What the result carries of the page's console and network: it rides a
	// step.result frame (1 MB), so 200 entries of each, cut to 512 bytes, and
	// 200 requests to the app; with 100 step values, under half a frame. The
	// HAR artifact keeps every request whole.
	maxEntries     = 200
	maxConsoleText = 512
	maxURL         = 512
	maxRoute       = 256
	// A trace is read back up to this much uncompressed (a zip bomb stops here).
	maxTraceInflated = 96 << 20
)

// RunSpec is one runner container: the claim, its workload machine, the
// exposed service the page loads, and how long the container may live.
type RunSpec struct {
	ClaimID  string
	Workload string
	Service  string
	Port     int
	Deadline time.Duration
}

// Runner starts the browser runner for one round: it writes job to the
// container's stdin, the container's stdout (one tar stream) to out, and
// returns when the container ended. A job the runner refused is
// ErrJobRefused.
type Runner interface {
	Run(ctx context.Context, spec RunSpec, job []byte, out io.Writer) error
}

// ErrJobRefused is the runner's exit 2: the steps were not the closed list.
var ErrJobRefused = errors.New("browser: the runner refused the job")

// Redactor is the claim's (redact.Redactor).
type Redactor interface {
	String(s string) (string, int)
}

func refuse(code, format string, a ...any) error {
	return &observer.ProbeRefusedError{Code: code, Reason: fmt.Sprintf(format, a...)}
}

var (
	servicePath      = regexp.MustCompile(`^/([^/\\][^\\]*)?$`)
	internalSelector = regexp.MustCompile(`(^|>>\s*)internal:`)
	keyName          = regexp.MustCompile(`^[A-Za-z0-9+]{1,64}$`)
)

// kindOf is the one kind a step names; "" when it names none or more than one.
func kindOf(s protocol.BrowserStep) protocol.BrowserStepKind {
	var kinds []protocol.BrowserStepKind
	add := func(set bool, k protocol.BrowserStepKind) {
		if set {
			kinds = append(kinds, k)
		}
	}
	add(s.Goto != nil, protocol.BrowserStepKindGoto)
	add(s.Click != nil, protocol.BrowserStepKindClick)
	add(s.Fill != nil, protocol.BrowserStepKindFill)
	add(s.Select != nil, protocol.BrowserStepKindSelect)
	add(s.Press != nil, protocol.BrowserStepKindPress)
	add(s.WaitFor != nil, protocol.BrowserStepKindWaitFor)
	add(s.ExpectText != nil, protocol.BrowserStepKindExpectText)
	add(s.GetAttribute != nil, protocol.BrowserStepKindGetAttribute)
	add(s.Screenshot != nil, protocol.BrowserStepKindScreenshot)
	if len(kinds) != 1 {
		return ""
	}
	return kinds[0]
}

// Check holds a browser probe to the closed list (S-31) before any
// container starts: one kind per step, paths on the app that read the
// behavior and not the code, no internal selector engine, a plain key name,
// and no role (loginAs has no browser form yet).
func Check(p protocol.BrowserProbe) error {
	if len(p.Steps) < 1 || len(p.Steps) > 100 {
		return refuse("invalid_probe", "a browser probe has 1 to 100 steps")
	}
	if p.Viewport.Width < 200 || p.Viewport.Width > 4096 || p.Viewport.Height < 200 || p.Viewport.Height > 4096 {
		return refuse("invalid_probe", "viewport %dx%d is out of bounds", p.Viewport.Width, p.Viewport.Height)
	}
	if p.Role != nil {
		return refuse("role_unavailable", "browser probes log in by no role yet")
	}
	if p.Clock != nil {
		if _, err := protocol.ParseTime(*p.Clock); err != nil {
			return refuse("invalid_probe", "clock is not a date-time")
		}
	}
	d := time.Duration(p.TimeoutMs) * time.Millisecond
	if d < observer.MinProbeTimeout || d > observer.MaxProbeTimeout {
		return refuse("invalid_probe", "timeoutMs %d is outside [%d, %d]", p.TimeoutMs, observer.MinProbeTimeout.Milliseconds(), observer.MaxProbeTimeout.Milliseconds())
	}
	selector := func(i int, sel string) error {
		if internalSelector.MatchString(sel) {
			return refuse("invalid_probe", "step %d: internal selectors are not part of the closed list", i)
		}
		return nil
	}
	for i, s := range p.Steps {
		switch kindOf(s) {
		case protocol.BrowserStepKindGoto:
			path := *s.Goto
			if !servicePath.MatchString(path) {
				return refuse("invalid_path", "step %d: goto takes a path on the app", i)
			}
			if observer.IsSideDetectingPath(strings.SplitN(strings.SplitN(path, "?", 2)[0], "#", 2)[0]) {
				return refuse("side_detection", "step %d: %s reads the code, not the behavior", i, path)
			}
		case protocol.BrowserStepKindClick:
			if err := selector(i, *s.Click); err != nil {
				return err
			}
		case protocol.BrowserStepKindWaitFor:
			if err := selector(i, *s.WaitFor); err != nil {
				return err
			}
		case protocol.BrowserStepKindFill, protocol.BrowserStepKindSelect, protocol.BrowserStepKindExpectText, protocol.BrowserStepKindGetAttribute:
			pair := firstOf(s.Fill, s.Select, s.ExpectText, s.GetAttribute)
			if len(pair) != 2 {
				return refuse("invalid_probe", "step %d takes [selector, value]", i)
			}
			if err := selector(i, pair[0]); err != nil {
				return err
			}
		case protocol.BrowserStepKindPress:
			if !keyName.MatchString(*s.Press) {
				return refuse("invalid_probe", "step %d: press takes a key name", i)
			}
		case protocol.BrowserStepKindScreenshot:
		default:
			return refuse("invalid_probe", "step %d is not one of the closed list", i)
		}
	}
	return nil
}

func firstOf(pairs ...[]string) []string {
	for _, p := range pairs {
		if p != nil {
			return p
		}
	}
	return nil
}

// Session is how long the browser may play the steps: the probe's timeout,
// at least MinSession and at most MaxSession (the video's bound).
func Session(p protocol.BrowserProbe) time.Duration {
	return min(max(time.Duration(p.TimeoutMs)*time.Millisecond, MinSession), MaxSession)
}

// job is what the runner reads on stdin (browser-runner/runner.mjs).
type job struct {
	Evidence  protocol.EvidenceLevel        `json:"evidence"`
	Steps     []protocol.BrowserStep        `json:"steps"`
	Viewport  protocol.BrowserProbeViewport `json:"viewport"`
	Origin    string                        `json:"origin"`
	TimeoutMs int64                         `json:"timeoutMs"`
	Clock     *string                       `json:"clock,omitempty"`
}

// Job is the runner's stdin for a probe whose app listens on port.
func Job(p protocol.BrowserProbe, port int) ([]byte, error) {
	return jobFor(p, port, protocol.EvidenceLevelFull)
}

func jobFor(p protocol.BrowserProbe, port int, evidence protocol.EvidenceLevel) ([]byte, error) {
	return json.Marshal(job{
		Evidence:  evidence,
		Steps:     p.Steps,
		Viewport:  p.Viewport,
		Origin:    "http://" + AppHost + ":" + strconv.Itoa(port),
		TimeoutMs: Session(p).Milliseconds(),
		Clock:     p.Clock,
	})
}
