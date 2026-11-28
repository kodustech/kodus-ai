// Package buildprogress reads BuildKit's plain progress output (buildctl
// --progress plain) into per-step durations, so a slow build says which of
// its steps took the time. It keeps no output, only each step's name and
// how it ended, and at most MaxSteps of them. Of what a step printed it keeps
// only the first lines that read as errors and the last few (redacted and
// bounded), so a failed build names what failed (Failure) instead of the
// docker command that ran it.
//
// The lines it reads:
//
//	#5 [internal] load build context      the step's name (its first line)
//	#5 transferring context: 1.2GB 40.1s  a status line
//	#8 12.345 compiling...                a line the step printed
//	#5 DONE 44.1s                         the step ended after 44.1 s
//	#7 CACHED                             the step came from the cache
//	#8 ERROR: process did not complete    the step failed
//	#8 CANCELED                           the step was stopped
package buildprogress

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

const (
	// MaxSteps bounds the steps a Tracker keeps: a larger build's later steps
	// are not counted.
	MaxSteps = 1024
	// MaxName bounds a step's name, in bytes; a longer one is cut.
	MaxName = 160
	// MaxErrorLines is how many error lines a step keeps (its first), and
	// MaxTailLines how many of its last lines; MaxLine bounds each. The tail
	// is what a developer's coding agent reads to fix a failed build (a
	// compiler's errors are the last lines of the step), so it is long enough
	// for a whole error report and its lines are not cut short.
	MaxErrorLines = 8
	MaxTailLines  = 40
	MaxLine       = 500
	// maxKeptLines bounds the lines a Tracker keeps across all its steps.
	maxKeptLines = 4096
)

// Step is one BuildKit step (vertex) as the build reported it.
type Step struct {
	Name     string `json:"name"`
	Ms       int64  `json:"ms"`
	Cached   bool   `json:"cached,omitempty"`
	Errored  bool   `json:"errored,omitempty"`
	Canceled bool   `json:"canceled,omitempty"`
	done     bool
}

// Summary is what a build's steps came to.
type Summary struct {
	Steps    int `json:"steps"`
	Done     int `json:"done"`
	Cached   int `json:"cached"`
	Errored  int `json:"errored"`
	Canceled int `json:"canceled"`
	// Slowest are the steps that ran longest, slowest first.
	Slowest []Step `json:"slowest"`
	// Phases are every phase of the build, slowest first (Phases).
	Phases []Phase `json:"-"`
}

// Tracker turns progress lines into steps. Safe for concurrent use.
type Tracker struct {
	mu    sync.Mutex
	steps map[int]*Step
	order []int
	// out is what each step printed that a failure may need.
	out  map[int]*stepOutput
	kept int
	// failedFirst is the first step that reported ERROR (0: none).
	failedFirst int
	// solveFailed: buildctl reported the solve failed (a line outside the
	// steps, "error: failed to solve: ...").
	solveFailed bool
	// times is when each step was seen (Phases); now is the clock.
	times map[int]*stepTime
	now   func() time.Time
	// last is when the builder printed its last line, a step's or not.
	last time.Time
}

// stepOutput is what a step printed, bounded: its first error lines, its
// last lines, its ERROR line, and whether it mounts a build cache.
type stepOutput struct {
	errors     []keptLine
	tail       []keptLine
	printed    int
	errLine    string
	cacheMount bool
	exited     bool
	exitCode   int
	segfaulted bool
}

// keptLine is a line a step printed with its place in the step's output, so
// an error line that is also in the tail is not told twice.
type keptLine struct {
	n    int
	text string
}

func New() *Tracker { return NewAt(time.Now) }

// NewAt is New on a clock of its own (tests): a step's phase while it runs
// counts from the line that named it to now.
func NewAt(now func() time.Time) *Tracker {
	return &Tracker{steps: map[int]*Step{}, out: map[int]*stepOutput{}, times: map[int]*stepTime{}, now: now}
}

// Failure is the first step BuildKit reported failed.
type Failure struct {
	// Step is its name (redacted, bounded).
	Step string
	// Lines are the first lines it printed that read as errors and that
	// scrolled out of its last lines, then its last MaxTailLines lines, then
	// BuildKit's own ERROR line; redacted, each at most MaxLine bytes.
	Lines []string
	// ProcessExit: the step's command ran and exited unsuccessfully (a RUN
	// that failed), not BuildKit failing around it.
	ProcessExit bool
	// ExitCode is the command's exit status BuildKit reported ("exit code:
	// 139"), 0 when the step did not exit or BuildKit named none.
	ExitCode int
	// CacheMount: the step mounts a build cache (RUN --mount=type=cache),
	// which a build's persisted state provides.
	CacheMount bool
	// Segfaulted: a line the step printed says a process of its command died
	// of SIGSEGV, though the command itself exited with another status (a
	// dpkg script under gVisor: dpkg fails and the RUN exits 100).
	Segfaulted bool
}

// segfaultLine is how a shell, or a tool that ran a child, says the child died
// of SIGSEGV.
var segfaultLine = regexp.MustCompile(`\bSegmentation fault\b|\bexit status 139\b`)

// errorLine is a line a failing tool prints when it says why: npm, pnpm,
// node-gyp, apt, a compiler, a resolver error.
var errorLine = regexp.MustCompile(`(?i:\berr(or)?\b|\bfatal\b|\bfailed\b|\bcannot\b|\bcould not\b|\bnot found\b|\bpanic:|\bexception\b)|ERR!|\bERR_[A-Z0-9_]+|\bE[A-Z][A-Z_]{3,}\b|^E: `)

var (
	stepLine = regexp.MustCompile(`^#(\d{1,6}) (.+)$`)
	doneIn   = regexp.MustCompile(`^DONE (\d+(?:\.\d+)?)s$`)
	printed  = regexp.MustCompile(`^\d+\.\d+ `)
	// exitCodeLine is how BuildKit ends a failed RUN's error line.
	exitCodeLine = regexp.MustCompile(`exit code: (\d{1,3})\s*$`)
)

// Line reads one line of the build's progress output.
func (t *Tracker) Line(line string) {
	line = strings.TrimRight(line, "\r")
	t.mu.Lock()
	t.last = t.now()
	t.mu.Unlock()
	m := stepLine.FindStringSubmatch(line)
	if m == nil {
		if strings.Contains(line, "failed to solve") {
			t.mu.Lock()
			t.solveFailed = true
			t.mu.Unlock()
		}
		return
	}
	id, err := strconv.Atoi(m[1])
	if err != nil {
		return
	}
	rest := strings.TrimSpace(m[2])
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.step(id)
	if s == nil {
		return
	}
	now := t.now()
	t.seen(id, now)
	switch {
	case doneIn.MatchString(rest):
		s.Ms, s.done = parseSecs(doneIn.FindStringSubmatch(rest)[1]), true
	case rest == "CACHED":
		s.Cached = true
	case rest == "CANCELED":
		s.Canceled = true
	case rest == "ERROR" || strings.HasPrefix(rest, "ERROR:"):
		s.Errored = true
		if t.failedFirst == 0 {
			t.failedFirst = id
		}
		o := t.output(id)
		if o.errLine == "" {
			o.errLine = cleanLine(rest)
			o.exited = strings.Contains(rest, "did not complete successfully")
			if m := exitCodeLine.FindStringSubmatch(rest); o.exited && m != nil {
				o.exitCode, _ = strconv.Atoi(m[1])
			}
		}
	case printed.MatchString(rest):
		t.printed(id, printed.ReplaceAllString(rest, ""))
	case s.Name == "":
		s.Name = cleanName(rest)
		t.output(id).cacheMount = strings.Contains(rest, "--mount=type=cache")
	default:
		t.status(id, rest, now)
	}
}

// projectStep is the name BuildKit gives a step of the Dockerfile itself
// ("[deps 2/15] RUN ...", "[api 1/1] COPY ..."); its own steps are named
// otherwise ("[internal] load metadata ...", "docker-image://...").
//
// The stage is optional: a Dockerfile with no `AS` name numbers its steps
// "[2/5] RUN npm install", and a platform may come first
// ("[linux/amd64 build 2/5] RUN ..."). Reading only the named form left an
// `npm install` of an unnamed stage looking like a builder that hung.
//
// BuildKit pads the step number to the width of the step count, so a
// Dockerfile of ten or more steps names its first nine "[stage-0  2/13] RUN
// ..." (two spaces), or "[ 2/13]" with no stage: the separators are any run of
// blanks. Matching one space left every step before the tenth, an `apt-get
// install` that printed nothing for five minutes among them, looking like a
// builder that hung (seen live on a 13-step Dockerfile).
var projectStep = regexp.MustCompile(`^\[\s*(?:[^\]\s]+\s+){0,2}\d+/\d+\] `)

// LastLine is when the builder printed its last line; zero before the first.
func (t *Tracker) LastLine() time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.last
}

// ProjectStepRunning says whether a step of the Dockerfile is running: named,
// and not yet done, cached, failed or canceled.
func (t *Tracker) ProjectStepRunning() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, s := range t.steps {
		if s.done || s.Cached || s.Errored || s.Canceled {
			continue
		}
		if projectStep.MatchString(s.Name) {
			return true
		}
	}
	// A running step that mounts a build cache is a RUN of the project whatever its name reads like.
	for id, o := range t.out {
		if s := t.steps[id]; o.cacheMount && s != nil && !s.done && !s.Cached && !s.Errored && !s.Canceled {
			return true
		}
	}
	return false
}

// longPhases are the names of BuildKit's own steps that write for minutes
// without a line: the image or cache export, loading the tarball it made, and
// what is done to the cache around it.
var longPhases = []string{"exporting ", "sending tarball", "unpacking to ", "preparing build cache for export", "importing cache manifest"}

// ExportRunning says whether BuildKit is in a known long silent phase of the
// export (longPhases: "exporting ...", "sending tarball", ...) that is not yet
// done. The exporter prints nothing while it writes the layers.
func (t *Tracker) ExportRunning() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, s := range t.steps {
		if !s.done && !s.Cached && !s.Errored && !s.Canceled && isLongPhase(s.Name) {
			return true
		}
	}
	return false
}

// parseSecs is BuildKit's "12.345" seconds, in ms.
func parseSecs(s string) int64 {
	secs, _ := strconv.ParseFloat(s, 64)
	return int64(secs*1000 + 0.5)
}

func (t *Tracker) output(id int) *stepOutput {
	o := t.out[id]
	if o == nil {
		o = &stepOutput{}
		t.out[id] = o
	}
	return o
}

// printed keeps a line a step printed: among its first error lines, and
// among its last lines, while the tracker has room.
func (t *Tracker) printed(id int, line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	o := t.output(id)
	o.printed++
	if !o.segfaulted && segfaultLine.MatchString(line) {
		o.segfaulted = true
	}
	if len(o.errors) < MaxErrorLines && errorLine.MatchString(line) && t.kept < maxKeptLines {
		o.errors = append(o.errors, keptLine{o.printed, cleanLine(line)})
		t.kept++
	}
	switch {
	case len(o.tail) == MaxTailLines:
		o.tail = append(o.tail[:0], o.tail[1:]...)
	case t.kept >= maxKeptLines:
		return
	default:
		t.kept++
	}
	o.tail = append(o.tail, keptLine{o.printed, cleanLine(line)})
}

// Failure is the first step that reported ERROR, with what it printed;
// false when no step did (the builder ended some other way).
func (t *Tracker) Failure() (Failure, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.failedFirst == 0 {
		return Failure{}, false
	}
	s := t.steps[t.failedFirst]
	f := Failure{Step: s.Name}
	if f.Step == "" {
		f.Step = "#" + strconv.Itoa(t.failedFirst)
	}
	if o := t.out[t.failedFirst]; o != nil {
		f.ProcessExit, f.CacheMount, f.ExitCode, f.Segfaulted = o.exited, o.cacheMount, o.exitCode, o.segfaulted
		// An error line that is still in the tail is told once, where it was printed.
		for _, l := range o.errors {
			if len(o.tail) == 0 || l.n < o.tail[0].n {
				f.Lines = append(f.Lines, l.text)
			}
		}
		for _, l := range o.tail {
			f.Lines = append(f.Lines, l.text)
		}
		if o.errLine != "" {
			f.Lines = append(f.Lines, o.errLine)
		}
	}
	return f, true
}

// SolveFailed reports whether buildctl said the solve failed: BuildKit ran
// the build and the build failed, as opposed to the builder itself ending.
func (t *Tracker) SolveFailed() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.solveFailed
}

// step is the step with this id, made on its first line; nil past MaxSteps.
func (t *Tracker) step(id int) *Step {
	if s, ok := t.steps[id]; ok {
		return s
	}
	if len(t.steps) >= MaxSteps {
		return nil
	}
	s := &Step{}
	t.steps[id] = s
	t.order = append(t.order, id)
	return s
}

// Summary counts the steps and names the slowest n that ran (cached steps
// did not), in the order the build started them when they took as long.
func (t *Tracker) Summary(n int) Summary {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := Summary{Steps: len(t.steps), Slowest: []Step{}}
	var ran []Step
	for _, id := range t.order {
		s := *t.steps[id]
		switch {
		case s.Cached:
			out.Cached++
		case s.Errored:
			out.Errored++
		case s.Canceled:
			out.Canceled++
		case s.done:
			out.Done++
		}
		if s.done && !s.Cached {
			if s.Name == "" {
				s.Name = "#" + strconv.Itoa(id)
			}
			ran = append(ran, s)
		}
	}
	sort.SliceStable(ran, func(i, j int) bool { return ran[i].Ms > ran[j].Ms })
	if n >= 0 && len(ran) > n {
		ran = ran[:n]
	}
	out.Slowest = append(out.Slowest, ran...)
	out.Phases = t.phasesLocked(-1)
	return out
}

// A Dockerfile line can carry a value it should not (RUN TOKEN=... make):
// the token rules first, then any KEY=value whose key names a secret.
var secretAssign = regexp.MustCompile(`(?i)\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)`)

func cleanName(name string) string {
	name, _ = redact.Patterns(name)
	name = secretAssign.ReplaceAllString(name, "$1=[redacted]")
	clipped, _ := redact.Clip(name, MaxName)
	return clipped
}

// cleanLine is cleanName for a line a step printed, bounded by MaxLine.
func cleanLine(line string) string {
	line, _ = redact.Patterns(line)
	line = secretAssign.ReplaceAllString(line, "$1=[redacted]")
	clipped, _ := redact.Clip(line, MaxLine)
	return clipped
}

func isLongPhase(name string) bool {
	for _, p := range longPhases {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}
