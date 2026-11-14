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
