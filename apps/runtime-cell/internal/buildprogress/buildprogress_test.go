package buildprogress

import (
	"strconv"
	"strings"
	"testing"
)

// The plain progress of a one-line Go change on a warm state: the build
// context and the compile took the time, the module download was cached.
const goBuild = `#1 [internal] load build definition from Dockerfile
#1 transferring dockerfile: 1.02kB done
#1 DONE 0.1s

#2 [internal] load metadata for docker.io/library/golang:1.24
#2 DONE 1.4s

#5 [internal] load build context
#5 transferring context: 1.21GB 40.1s
#5 DONE 44.1s

#6 [build 2/6] COPY go.mod go.sum ./
#6 CACHED

#7 [build 3/6] RUN go mod download
#7 CACHED

#8 [build 5/6] RUN go build -o /out/grafana ./pkg/cmd/grafana
#8 0.512 go: downloading github.com/x/y v1.0.0
#9 [stage-1 2/3] RUN apk add --no-cache ca-certificates
#9 2.003 fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main
#8 [build 5/6] RUN go build -o /out/grafana ./pkg/cmd/grafana
#8 301.442 # github.com/grafana/grafana/pkg/api
#8 DONE 380.2s
#9 DONE 3.0s

#10 exporting to docker image format
#10 exporting layers 10.2s done
#10 DONE 25.3s
`

func feed(t *Tracker, out string) {
	for _, l := range strings.Split(out, "\n") {
		t.Line(l)
	}
}

func TestSummaryNamesTheSlowestStepsAndCountsTheCachedOnes(t *testing.T) {
	tr := New()
	feed(tr, goBuild)
	s := tr.Summary(3)
	if s.Steps != 8 || s.Cached != 2 || s.Done != 6 || s.Errored != 0 {
		t.Fatalf("counts: %+v", s)
	}
	want := []Step{
		{Name: "[build 5/6] RUN go build -o /out/grafana ./pkg/cmd/grafana", Ms: 380_200},
		{Name: "[internal] load build context", Ms: 44_100},
		{Name: "exporting to docker image format", Ms: 25_300},
	}
	if len(s.Slowest) != len(want) {
		t.Fatalf("slowest: %+v", s.Slowest)
	}
	for i := range want {
		if s.Slowest[i].Name != want[i].Name || s.Slowest[i].Ms != want[i].Ms || s.Slowest[i].Cached {
			t.Errorf("slowest[%d] = %+v, want %+v", i, s.Slowest[i], want[i])
		}
	}
}

// An interleaved step prints its name again when the output returns to
// it, and its output lines start with a timestamp: neither renames it.
func TestAStepKeepsTheNameOfItsFirstLine(t *testing.T) {
	tr := New()
	feed(tr, "#3 [a 1/2] RUN make\n#3 0.100 [b 1/1] RUN other\n#3 transferring: 2MB\n#3 [a 1/2] RUN make\n#3 DONE 2.0s\n")
	if s := tr.Summary(5); len(s.Slowest) != 1 || s.Slowest[0].Name != "[a 1/2] RUN make" || s.Slowest[0].Ms != 2_000 {
		t.Fatalf("%+v", s)
	}
}

func TestFailedAndCanceledStepsAreCountedNotRanked(t *testing.T) {
	tr := New()
	feed(tr, "#4 [build 4/6] RUN go test ./...\n#4 ERROR: process \"/bin/sh -c go test ./...\" did not complete successfully: exit code: 1\n#5 [stage-1 1/1] COPY . .\n#5 CANCELED\n")
	s := tr.Summary(5)
	if s.Errored != 1 || s.Canceled != 1 || len(s.Slowest) != 0 {
		t.Fatalf("%+v", s)
	}
}

func TestLinesThatAreNotProgressAreIgnored(t *testing.T) {
	tr := New()
	feed(tr, "kodus: api built in 50s\n\n#x not a step\n# comment\nDONE 3.0s\n")
	if s := tr.Summary(5); s.Steps != 0 {
		t.Fatalf("%+v", s)
	}
}

func TestAStepWithoutAHeaderIsNamedByItsNumber(t *testing.T) {
	tr := New()
	tr.Line("#12 DONE 1.5s")
	if s := tr.Summary(1); s.Slowest[0].Name != "#12" || s.Slowest[0].Ms != 1_500 {
		t.Fatalf("%+v", s)
	}
}

// What a Dockerfile line carries stays out of the log: a token, a secret
// assigned in a RUN, and anything past MaxName.
func TestNamesAreRedactedAndBounded(t *testing.T) {
	tr := New()
	tr.Line("#1 [build 1/2] RUN GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345 DB_PASSWORD='hunter2' make")
	tr.Line("#1 DONE 1.0s")
	tr.Line("#2 [build 2/2] RUN " + strings.Repeat("é", MaxName))
	tr.Line("#2 DONE 0.5s")
	s := tr.Summary(2)
	name := s.Slowest[0].Name
	if strings.Contains(name, "ghp_") || strings.Contains(name, "hunter2") || !strings.Contains(name, "DB_PASSWORD=[redacted]") {
		t.Fatalf("name kept a secret: %q", name)
	}
	if long := s.Slowest[1].Name; len(long) > MaxName || !strings.HasPrefix(long, "[build 2/2] RUN é") {
		t.Fatalf("long name: %d bytes %q", len(long), long)
	}
}

func TestATrackerKeepsAtMostMaxSteps(t *testing.T) {
	tr := New()
	for i := 1; i <= MaxSteps+50; i++ {
		tr.Line("#" + strconv.Itoa(i) + " step")
		tr.Line("#" + strconv.Itoa(i) + " DONE 0.1s")
	}
	if s := tr.Summary(-1); s.Steps != MaxSteps || len(s.Slowest) != MaxSteps {
		t.Fatalf("steps: %d slowest: %d", s.Steps, len(s.Slowest))
	}
}

// A failed npm install: the first lines that say why come out of the step's
// output; the docker command around the build used to be all the error had.
func TestFailureKeepsTheFirstErrorLinesOfTheFailedStep(t *testing.T) {
	tr := New()
	feed(tr, `#6 [deps 3/5] RUN --mount=type=cache,target=/root/.npm npm ci
#6 0.812 npm WARN deprecated inflight@1.0.6
#6 12.101 npm ERR! code ENOTFOUND
#6 12.102 npm ERR! syscall getaddrinfo
#6 12.103 npm ERR! errno ENOTFOUND
#6 12.104 npm ERR! network request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
#6 12.200 npm ERR! A complete log of this run can be found in: /root/.npm/_logs/debug.log
#6 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1
#7 [app 2/2] COPY . .
#7 CANCELED
error: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1
`)
	f, ok := tr.Failure()
	if !ok || f.Step != "[deps 3/5] RUN --mount=type=cache,target=/root/.npm npm ci" || !f.ProcessExit || !f.CacheMount {
		t.Fatalf("failure %+v", f)
	}
	if len(f.Lines) != 6 || f.Lines[0] != "npm ERR! code ENOTFOUND" || !strings.HasPrefix(f.Lines[5], "ERROR: process") {
		t.Fatalf("lines %q", f.Lines)
	}
	for _, l := range f.Lines {
		if strings.Contains(l, "WARN deprecated") {
			t.Fatalf("a warning was kept as an error: %q", l)
		}
	}
	if !tr.SolveFailed() {
		t.Fatal("the solve failure was not seen")
	}
}

// A step whose output says nothing that reads as an error still names its
// last lines, so the failure has some text of its own.
func TestFailureFallsBackToTheStepsLastLines(t *testing.T) {
	tr := New()
	tr.Line("#3 [b 1/1] RUN ./build.sh")
	for i := range 10 {
		tr.Line("#3 1.00" + strconv.Itoa(i) + " step " + strconv.Itoa(i))
	}
	tr.Line("#3 ERROR: process \"/bin/sh -c ./build.sh\" did not complete successfully: exit code: 2")
	f, ok := tr.Failure()
	if !ok || len(f.Lines) != MaxTailLines+1 || f.Lines[0] != "step 6" || f.CacheMount {
		t.Fatalf("%+v", f)
	}
}

// What a step printed is redacted and bounded, line by line and in number.
func TestFailureLinesAreRedactedAndBounded(t *testing.T) {
	tr := New()
	tr.Line("#2 [a 1/1] RUN make")
	tr.Line("#2 0.100 error: DB_PASSWORD=hunter2 ghp_0123456789abcdefghijABCDEFGHIJ012345 " + strings.Repeat("x", 2*MaxLine))
	for range 3 * MaxErrorLines {
		tr.Line("#2 0.200 error: again")
	}
	tr.Line("#2 ERROR: failed")
	f, _ := tr.Failure()
	if len(f.Lines) != MaxErrorLines+1 || f.ProcessExit {
		t.Fatalf("%d lines, exit %v", len(f.Lines), f.ProcessExit)
	}
	if l := f.Lines[0]; strings.Contains(l, "hunter2") || strings.Contains(l, "ghp_") || len(l) > MaxLine {
		t.Fatalf("kept %q", l)
	}
}

// The observed case: the builder ended with steps still running and none
// reported failed: no Failure, and no solve failure, so the cell can tell it
// from the code's.
func TestABuilderThatDiesLeavesNoFailure(t *testing.T) {
	tr := New()
	feed(tr, "#7 [base 3/9] RUN apt-get update && apt-get install -y build-essential\n#7 4.200 Get:1 http://deb.debian.org/debian bookworm InRelease\n")
	if _, ok := tr.Failure(); ok || tr.SolveFailed() {
		t.Fatal("a builder that died was read as a failed step")
	}
}

func TestErrorLinesAreTheOnesThatSayWhy(t *testing.T) {
	for _, l := range []string{
		"npm ERR! code E404", "ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/x: Not Found", "gyp ERR! stack Error: not found: make",
		"getaddrinfo EAI_AGAIN registry.npmjs.org", "E: Unable to locate package libfoo", "error: linker `cc` not found", "Err:1 http://deb.debian.org bookworm InRelease",
		"fatal: unable to access 'https://github.com/x/y/'", "go: github.com/x/y@v1.0.0: reading https://proxy.golang.org: 403 Forbidden: failed",
	} {
		if !errorLine.MatchString(l) {
			t.Errorf("not an error line: %q", l)
		}
	}
	for _, l := range []string{"npm WARN deprecated inflight@1.0.6", "Setting up everything (1.2.3) ...", "Get:1 http://deb.debian.org/debian bookworm InRelease", "added 812 packages in 30s"} {
		if errorLine.MatchString(l) {
			t.Errorf("an error line: %q", l)
		}
	}
}
