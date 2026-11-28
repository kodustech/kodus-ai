package buildprogress

import (
	"regexp"
	"sort"
	"strings"
	"time"
)

// Phases say where a build's time went in words a person reads at a glance
// ("yarn install 16m45s · export layers 21m"), where Summary names the
// Dockerfile lines. Each step that ran becomes one phase, named by what it
// did: the base image it pulled, a RUN by its command, a COPY by its
// arguments. The export step is split into what it did inside (BuildKit's
// own sub-timers: exporting layers, sending tarball, pushing layers), since
// that is where an image of many files spends its time.
//
// A step still running when Phases is read (the claim's ceiling stopped the
// build, or the read is a snapshot) counts until then and is Running: what a
// timed-out setup was doing is the phase it stopped in.

// Phase is a part of a build and how long it took.
type Phase struct {
	Name string `json:"name"`
	Ms   int64  `json:"ms"`
	// Running: it had not finished when the phases were read.
	Running bool `json:"running,omitempty"`
}

// MaxPhaseName bounds a phase's name, in bytes.
const MaxPhaseName = 48

// The export step's sub-timers BuildKit prints as "<what> 12.3s done".
var exportParts = []struct{ prefix, phase string }{
	{"exporting layers", "export layers"},
	{"sending tarball", "send tarball"},
	{"pushing layers", "push layers"},
	{"preparing build cache for export", "export cache"},
	{"writing layer", "export cache"},
	{"unpacking to", "unpack image"},
}

// exportPhases are the distinct phases of exportParts, in a fixed order.
var exportPhases = []string{"export layers", "send tarball", "push layers", "export cache", "unpack image"}

var (
	statusDone = regexp.MustCompile(`^(.+?) (\d+(?:\.\d+)?)s done$`)
	// [stage 2/7] RUN ..., [3/3] COPY ..., [internal] load ...
	stageInstr = regexp.MustCompile(`^\[[^\]]*\] ([A-Z]+) (.*)$`)
	digestPart = regexp.MustCompile(`@sha256:[a-f0-9]+$`)
	envAssign  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
)

// exportPart is the phase of an export step's sub-timer, "" for one that is not.
func exportPart(status string) string {
	for _, p := range exportParts {
		if strings.HasPrefix(status, p.prefix) {
			return p.phase
		}
	}
	return ""
}

// phaseName is what a step is called among the phases, from its (already
// redacted) name; "" for a step not worth one (BuildKit reading the
// Dockerfile, a WORKDIR).
func phaseName(step string) string {
	switch {
	case step == "":
		return ""
	case strings.HasPrefix(step, "[internal] load build context"):
		return "send context"
	case strings.HasPrefix(step, "[internal] load metadata for "):
		return "pull " + shortImage(strings.TrimPrefix(step, "[internal] load metadata for "))
	case strings.HasPrefix(step, "[internal] load build definition"), strings.HasPrefix(step, "[internal] load .dockerignore"):
		return ""
	case strings.HasPrefix(step, "exporting cache"):
		return "export cache"
	case strings.HasPrefix(step, "importing cache"):
		return "import cache"
	case strings.HasPrefix(step, "exporting to "):
		return "export"
	case strings.HasPrefix(step, "resolve image config for "):
		return "pull " + shortImage(strings.TrimPrefix(step, "resolve image config for "))
	}
	m := stageInstr.FindStringSubmatch(step)
	if m == nil {
		return clipPhase(step)
	}
	switch args := strings.TrimSpace(m[2]); m[1] {
	case "FROM":
		return "pull " + shortImage(firstField(args))
	case "RUN":
		return clipPhase(runLabel(args))
	case "COPY", "ADD":
		return clipPhase(m[1] + " " + strings.Join(withoutFlags(strings.Fields(args)), " "))
	case "WORKDIR", "USER", "ENV", "ARG", "LABEL", "EXPOSE", "CMD", "ENTRYPOINT":
		return ""
	default:
		return clipPhase(m[1] + " " + args)
	}
}

// shortImage is an image reference without its registry, library/ and
// digest: docker.io/library/node:20@sha256:... is node:20.
func shortImage(ref string) string {
	ref = digestPart.ReplaceAllString(strings.TrimSpace(ref), "")
	if i := strings.Index(ref, "/"); i > 0 && strings.ContainsAny(ref[:i], ".:") {
		ref = ref[i+1:]
	}
	ref = strings.TrimPrefix(ref, "library/")
	return clipPhase(ref)
}

// runLabel is a RUN's command in two words: the program and what it was
// asked (yarn install, npm ci, go build, apt-get update), past the RUN's own
// flags (--mount=...), the shell's set -e and any VAR=value before it.
func runLabel(cmd string) string {
	fields := withoutFlags(strings.Fields(cmd))
	for len(fields) > 0 {
		f := fields[0]
		switch {
		case envAssign.MatchString(f):
			fields = fields[1:]
		case f == "set" && len(fields) > 1 && strings.HasPrefix(fields[1], "-"):
			fields = skipToCommand(fields[2:])
		case f == "&&" || f == ";" || f == "\\" || f == "exec":
			fields = fields[1:]
		default:
			return twoWords(fields)
		}
	}
	return "RUN"
}

// skipToCommand drops what is left of a "set -eux;" or "set -e &&".
func skipToCommand(fields []string) []string {
	for len(fields) > 0 && (fields[0] == "&&" || fields[0] == ";" || strings.HasPrefix(fields[0], "-")) {
		fields = fields[1:]
	}
	return fields
}

func twoWords(fields []string) string {
	prog := strings.TrimSuffix(strings.TrimSuffix(fields[0], ";"), "&&")
	if i := strings.LastIndex(prog, "/"); i >= 0 && i < len(prog)-1 {
		prog = prog[i+1:]
	}
	if len(fields) > 1 {
		sub := strings.TrimSuffix(fields[1], ";")
		if sub != "" && !strings.HasPrefix(sub, "-") && sub != "&&" && sub != "|" && !strings.ContainsAny(sub, "/=$\"'") {
			return prog + " " + sub
		}
	}
	return prog
}

func withoutFlags(fields []string) []string {
	for len(fields) > 0 && strings.HasPrefix(fields[0], "--") {
		fields = fields[1:]
	}
	return fields
}

func firstField(s string) string {
	if f := strings.Fields(s); len(f) > 0 {
		return f[0]
	}
	return s
}

func clipPhase(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= MaxPhaseName {
		return s
	}
	cut := MaxPhaseName - len("…")
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// stepTime is when a step was first seen and what its export sub-timers
// took (export steps only).
type stepTime struct {
	first, last time.Time
	parts       map[string]int64
	partStart   map[string]time.Time
}

// seen notes a line of the step at now.
func (t *Tracker) seen(id int, now time.Time) *stepTime {
	st := t.times[id]
	if st == nil {
		st = &stepTime{first: now}
		t.times[id] = st
	}
	st.last = now
	return st
}

// status reads a line of a step that is neither its name, its end nor what
// it printed: an export sub-timer starting ("sending tarball") or done
// ("sending tarball 87.1s done").
func (t *Tracker) status(id int, rest string, now time.Time) {
	st := t.times[id]
	if st == nil {
		return
	}
	if m := statusDone.FindStringSubmatch(rest); m != nil {
		if part := exportPart(m[1]); part != "" {
			secs := parseSecs(m[2])
			if st.parts == nil {
				st.parts = map[string]int64{}
			}
			st.parts[part] += secs
			delete(st.partStart, part)
		}
		return
	}
	if part := exportPart(rest); part != "" {
		if st.partStart == nil {
			st.partStart = map[string]time.Time{}
		}
		if _, ok := st.partStart[part]; !ok {
			st.partStart[part] = now
		}
	}
}

// Phases are the build's phases, slowest first, at most n (n < 0: all).
// Phases of the same name add up (two pulls of one image, two exports).
// Cached steps took no time and are left out.
func (t *Tracker) Phases(n int) []Phase {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.phasesLocked(n)
}

func (t *Tracker) phasesLocked(n int) []Phase {
	now := t.now()
	sums := map[string]*Phase{}
	var order []string
	add := func(name string, ms int64, running bool) {
		if name == "" || ms <= 0 {
			return
		}
		p := sums[name]
		if p == nil {
			p = &Phase{Name: name}
			sums[name] = p
			order = append(order, name)
		}
		p.Ms += ms
		p.Running = p.Running || running
	}
	for _, id := range t.order {
		s := t.steps[id]
		if s.Cached {
			continue
		}
		st := t.times[id]
		name := phaseName(s.Name)
		ms, running := s.Ms, false
		if !s.done {
			if st == nil {
				continue
			}
			// Errored or canceled: until its last line. Still running: until now.
			end := st.last
			if !s.Errored && !s.Canceled {
				end, running = now, true
			}
			ms = end.Sub(st.first).Milliseconds()
		}
		if st != nil && (len(st.parts) > 0 || len(st.partStart) > 0) {
			// The export's own time is the sum of its parts; what is left
			// (manifest, config, naming) is not worth a phase.
			for _, part := range exportPhases {
				add(part, st.parts[part], false)
				if at, ok := st.partStart[part]; ok && running {
					add(part, now.Sub(at).Milliseconds(), true)
				}
			}
			continue
		}
		if name == "export" && !s.done && !running {
			continue
		}
		add(name, ms, running)
	}
	out := make([]Phase, 0, len(order))
	for _, name := range order {
		out = append(out, *sums[name])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Ms > out[j].Ms })
	if n >= 0 && len(out) > n {
		out = out[:n]
	}
	return out
}
