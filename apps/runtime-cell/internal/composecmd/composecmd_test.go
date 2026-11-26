package composecmd

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

func TestEachVerbIsTheComposeCommandLineTheDriversRun(t *testing.T) {
	since := time.Date(2026, 11, 14, 10, 0, 0, 0, time.FixedZone("x", 3600))
	until := since.Add(time.Minute)
	full := Project{Name: "p", Dir: "/work", File: "c.yml", EnvFile: ".env"}
	for _, tc := range []struct {
		name string
		got  []string
		want string
	}{
		{"ps lists stopped containers too, as json", Ps("p"), "compose -p p ps -a --format json"},
		{
			"logs window is stamped, bounded and in UTC",
			LogsWindow("p", "api", since, until, 50),
			"compose -p p logs --no-color --no-log-prefix --timestamps --since 2026-11-14T09:00:00Z --until 2026-11-14T09:01:00Z --tail 50 -- api",
		},
		{
			"up from prebuilt images builds nothing and keeps no orphan",
			full.UpPrebuilt("api", "db"),
			"compose -p p --project-directory /work -f c.yml --env-file .env up -d --no-build --wait --remove-orphans -- api db",
		},
		{
			"up with a build waits a bounded time",
			Project{Name: "p", File: "c.yml"}.UpBuild(540),
			"compose -p p -f c.yml up -d --build --wait --wait-timeout 540 --quiet-pull",
		},
		// F3-02: down and stop waited each container's own stop_grace_period,
		// which a compose file set to years; the cell bounds the wait.
		{"down by name keeps volumes unless asked", Down("p", false), "compose -p p down --remove-orphans -t 10"},
		{"down with volumes removes them", Down("p", true), "compose -p p down --remove-orphans -t 10 -v"},
		{"stop waits the cell's bound", Stop("p"), "compose -p p stop -t 10"},
		// F3-04: a service a compose file names "--dry-run" read as a flag.
		{"stop names services after the flags", Stop("p", "--dry-run"), "compose -p p stop -t 10 -- --dry-run"},
		{"kill signals the named services only", Kill("p", "SIGUSR2", "api", "worker"), "compose -p p kill -s SIGUSR2 -- api worker"},
		{"exec runs without a tty", Project{Name: "p"}.Exec("api", "sh", "-c", "x"), "compose -p p exec -T -- api sh -c x"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := strings.Join(tc.got, " "); got != tc.want {
				t.Fatalf("got  %q\nwant %q", got, tc.want)
			}
		})
	}
}

// F3-04: a service named "-f" turned logs into a follow.
func TestLogsNameTheServiceAfterTheFlags(t *testing.T) {
	argv := LogsWindow("p", "-f", time.Unix(0, 0), time.Unix(1, 0), 5)
	if got := strings.Join(argv[len(argv)-2:], " "); got != "-- -f" {
		t.Fatalf("logs end %q", got)
	}
}

func TestAJoinedCommandLineReachesTheProgramWordForWord(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	for _, words := range [][]string{
		{"plain", "-p", "kodus-claim-1", "a=b", "x.yml"},
		{"it's", `"double"`, `back\slash`, ""},
		{"$(echo pwned)", "`id`", "${HOME}", "$HOME"},
		{"line one\nline two", "tab\there", "semi;colon", "a|b", "a&&b", "*", "~", "#comment"},
		{"'; rm -rf / #", `'\''`, "\x01ctl"},
	} {
		t.Run(words[0], func(t *testing.T) {
			out, err := exec.Command(sh, "-c", `printf '%s\0' `+ShellJoin(words...)).Output()
			if err != nil {
				t.Fatal(err)
			}
			got := strings.Split(strings.TrimSuffix(string(out), "\x00"), "\x00")
			if !reflect.DeepEqual(got, words) {
				t.Fatalf("got %q, want %q", got, words)
			}
		})
	}
	out, err := exec.Command(sh, "-c", `printf '%s' `+ShellQuote("$(echo no) 'q'\n")).Output()
	if err != nil || !bytes.Equal(out, []byte("$(echo no) 'q'\n")) {
		t.Fatalf("ShellQuote: %q %v", out, err)
	}
}

func TestDockerLineRunsTheDockerBinary(t *testing.T) {
	if got := DockerLine(Ps("kodus-c1")); got != "docker compose -p kodus-c1 ps -a --format json" {
		t.Fatalf("got %q", got)
	}
}

type fakeLogs struct {
	ps   string
	logs map[string]string
	errs map[string]error
	asks []string
}

func (f *fakeLogs) ComposePs(context.Context, string) ([]byte, error) { return []byte(f.ps), nil }

func (f *fakeLogs) ComposeLogsWindow(_ context.Context, _, service string, _, _ time.Time, lines int) ([]byte, error) {
	f.asks = append(f.asks, service)
	if err := f.errs[service]; err != nil {
		return nil, err
	}
	return []byte(f.logs[service]), nil
}

var errDaemon = errors.New("daemon gone")

func TestServiceLogs(t *testing.T) {
	ps := `[{"Service":"api","State":"running"},{"Service":"db","State":"running"}]`
	at := func(s int) time.Time { return time.Date(2026, 1, 1, 0, 0, s, 0, time.UTC) }
	for _, tc := range []struct {
		name    string
		logs    map[string]string
		errs    map[string]error
		max     int
		want    []driver.ServiceLogLine
		wantErr error
	}{
		{
			name: "lines of every service come merged oldest first, the newest max kept",
			logs: map[string]string{
				"api": "2026-01-01T00:00:01Z a1\n2026-01-01T00:00:04Z a4\n",
				"db":  "2026-01-01T00:00:02Z d2\n2026-01-01T00:00:03Z d3\n",
			},
			max:  3,
			want: []driver.ServiceLogLine{{Service: "db", At: at(2), Text: "d2"}, {Service: "db", At: at(3), Text: "d3"}, {Service: "api", At: at(4), Text: "a4"}},
		},
		{
			name: "a service that fails is skipped when another gave lines",
			logs: map[string]string{"db": "2026-01-01T00:00:02Z d2\n"},
			errs: map[string]error{"api": errDaemon},
			max:  10,
			want: []driver.ServiceLogLine{{Service: "db", At: at(2), Text: "d2"}},
		},
		{
			name:    "when no service gave a line, each failure stays matchable",
			errs:    map[string]error{"api": errDaemon, "db": context.DeadlineExceeded},
			max:     10,
			wantErr: errDaemon,
		},
		{name: "no line asked is no command run", max: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeLogs{ps: ps, logs: tc.logs, errs: tc.errs}
			got, err := ServiceLogs(context.Background(), f, "p", at(0), at(9), tc.max)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) || !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("err = %v, want it to match %v and the deadline", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v\nwant %+v", got, tc.want)
			}
			if tc.max == 0 && len(f.asks) != 0 {
				t.Fatalf("asked logs of %v", f.asks)
			}
		})
	}
}

// A ready check ends at once on a service that exited; it keeps waiting on one still
// starting. The cell tells them apart by compose ps: only a container that ran and
// stopped is exited, with the code it exited with and the tail of its log.
type exitedRunner struct {
	ps   string
	logs map[string]string
}

func (r exitedRunner) ComposePs(context.Context, string) ([]byte, error) { return []byte(r.ps), nil }
func (r exitedRunner) ComposeLogs(_ context.Context, _, service string, _ int) ([]byte, error) {
	return []byte(r.logs[service]), nil
}

func TestOnlyAServiceThatExitedIsReportedWithItsExitCodeAndLogTail(t *testing.T) {
	r := exitedRunner{
		ps: `{"Service":"api","State":"exited","Status":"Exited (3) 4 seconds ago","ExitCode":3}` + "\n" +
			`{"Service":"db","State":"running","Status":"Up 2 minutes","ExitCode":0}` + "\n" +
			`{"Service":"worker","State":"created","Status":"Created","ExitCode":0}`,
		logs: map[string]string{"api": "migrating\nseed failed: no such table\n", "db": "ready\n"},
	}
	got, err := ExitedServices(context.Background(), r, "m-1", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "api" || got[0].ExitCode != 3 || got[0].State != "Exited (3) 4 seconds ago" ||
		len(got[0].Log) != 2 || got[0].Log[1] != "seed failed: no such table" {
		t.Fatalf("exited %+v", got)
	}
}
