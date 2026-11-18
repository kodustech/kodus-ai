// Package preflight checks a host against what the cell assumes at run time,
// before the cell is installed or updated (`cell preflight`, and `cell
// update` before it swaps releases): one result per check, ok, warn or fail,
// with the reason and how to fix it. A fail is what the cell would refuse at
// start or what breaks every claim; a warn is what the cell starts with but
// runs worse.
//
// Like kubeadm's preflight, each check has a name and a fail stops the
// install; unlike it there is no list of errors to ignore: a fail is the
// cell's own refusal, read ahead. The checks only read the host, with one
// exception the microVM cell already makes at start: firecracker.Missing
// creates the state directory and a probe file in it to test reflinks.
//
// Every check names, in its comment, the runtime code that depends on it.
// The rules that belong to a driver (claim limits, the microVM
// prerequisites) are that driver's own functions, which the composition root
// passes in: this package picks no driver.
package preflight

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// Status is a check's verdict.
type Status string

// Verdicts.
const (
	OK   Status = "ok"
	Warn Status = "warn"
	Fail Status = "fail"
)

// Result is one check on the host.
type Result struct {
	// Name is the check's, stable across releases (docs and scripts grep it).
	Name   string `json:"name"`
	Status Status `json:"status"`
	// Reason is what was found.
	Reason string `json:"reason"`
	// Fix is what the operator does about a warn or a fail.
	Fix string `json:"fix,omitempty"`
}

func ok(name, reason string) Result { return Result{Name: name, Status: OK, Reason: reason} }

func warn(name, reason, fix string) Result {
	return Result{Name: name, Status: Warn, Reason: reason, Fix: fix}
}

func fail(name, reason, fix string) Result {
	return Result{Name: name, Status: Fail, Reason: reason, Fix: fix}
}

// Report is every check of one run.
type Report struct {
	// Driver is the driver the settings resolve to; Why says how.
	Driver string `json:"driver,omitempty"`
	Why    string `json:"why,omitempty"`
	// Results are in the order they ran.
	Results []Result `json:"checks"`
	// Notes say what was not checked here, and why.
	Notes []string `json:"notes,omitempty"`
}

// Add appends results.
func (r *Report) Add(rs ...Result) { r.Results = append(r.Results, rs...) }

// Failed reports whether any check failed.
func (r Report) Failed() bool {
	for _, x := range r.Results {
		if x.Status == Fail {
			return true
		}
	}
	return false
}

// ExitCode is the command's: 1 when a check failed, else 0 (warnings
// included).
func (r Report) ExitCode() int {
	if r.Failed() {
		return 1
	}
	return 0
}

func (r Report) counts() (oks, warns, fails int) {
	for _, x := range r.Results {
		switch x.Status {
		case OK:
			oks++
		case Warn:
			warns++
		case Fail:
			fails++
		}
	}
	return oks, warns, fails
}

// WriteText writes one line per check ("fail runsc: reason; fix: ..."), the
// notes, then a summary line.
func (r Report) WriteText(w io.Writer) error {
	var b strings.Builder
	if r.Driver != "" {
		fmt.Fprintf(&b, "driver %s (%s)\n", r.Driver, r.Why)
	}
	width := 0
	for _, x := range r.Results {
		width = max(width, len(x.Name))
	}
	for _, x := range r.Results {
		fmt.Fprintf(&b, "%-4s %-*s %s", x.Status, width, x.Name, x.Reason)
		if x.Fix != "" {
			fmt.Fprintf(&b, "; fix: %s", x.Fix)
		}
		b.WriteByte('\n')
	}
	for _, n := range r.Notes {
		fmt.Fprintf(&b, "note %s\n", n)
	}
	oks, warns, fails := r.counts()
	verdict := "passed"
	if fails > 0 {
		verdict = "failed"
	}
	fmt.Fprintf(&b, "preflight %s: %d ok, %d warn, %d fail\n", verdict, oks, warns, fails)
	_, err := io.WriteString(w, b.String())
	return err
}

// WriteJSON writes the report as one JSON object, with "ok" false when a
// check failed.
func (r Report) WriteJSON(w io.Writer) error {
	out := struct {
		OK bool `json:"ok"`
		Report
	}{!r.Failed(), r}
	if out.Results == nil {
		out.Results = []Result{}
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}
