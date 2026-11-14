// Package buildprogress reads BuildKit's plain progress output (buildctl
// --progress plain) into per-step durations, so a slow build says which of
// its steps took the time. It keeps no output, only each step's name and
// how it ended, and at most MaxSteps of them.
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

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

const (
	// MaxSteps bounds the steps a Tracker keeps: a larger build's later steps
	// are not counted.
	MaxSteps = 1024
	// MaxName bounds a step's name, in bytes; a longer one is cut.
	MaxName = 160
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
}

// Tracker turns progress lines into steps. Safe for concurrent use.
type Tracker struct {
	mu    sync.Mutex
	steps map[int]*Step
	order []int
}

func New() *Tracker { return &Tracker{steps: map[int]*Step{}} }

var (
	stepLine = regexp.MustCompile(`^#(\d{1,6}) (.+)$`)
	doneIn   = regexp.MustCompile(`^DONE (\d+(?:\.\d+)?)s$`)
	printed  = regexp.MustCompile(`^\d+\.\d+ `)
)

// Line reads one line of the build's progress output.
func (t *Tracker) Line(line string) {
	m := stepLine.FindStringSubmatch(strings.TrimRight(line, "\r"))
	if m == nil {
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
	switch {
	case doneIn.MatchString(rest):
		secs, _ := strconv.ParseFloat(doneIn.FindStringSubmatch(rest)[1], 64)
		s.Ms, s.done = int64(secs*1000+0.5), true
	case rest == "CACHED":
		s.Cached = true
	case rest == "CANCELED":
		s.Canceled = true
	case rest == "ERROR" || strings.HasPrefix(rest, "ERROR:"):
		s.Errored = true
	case s.Name == "" && !printed.MatchString(rest):
		s.Name = cleanName(rest)
	}
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
