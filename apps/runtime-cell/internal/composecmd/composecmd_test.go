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
			"compose -p p logs --no-color --no-log-prefix --timestamps --since 2026-11-14T09:00:00Z --until 2026-11-14T09:01:00Z --tail 50 api",
		},
		{
			"up from prebuilt images builds nothing and keeps no orphan",
			full.UpPrebuilt("api", "db"),
			"compose -p p --project-directory /work -f c.yml --env-file .env up -d --no-build --wait --remove-orphans api db",
		},
		{
			"up with a build waits a bounded time",
			Project{Name: "p", File: "c.yml"}.UpBuild(540),
			"compose -p p -f c.yml up -d --build --wait --wait-timeout 540 --quiet-pull",
		},
		{"down by name keeps volumes unless asked", Down("p", false), "compose -p p down --remove-orphans"},
		{"down with volumes removes them", Down("p", true), "compose -p p down --remove-orphans -v"},
		{"exec runs without a tty", Project{Name: "p"}.Exec("api", "sh", "-c", "x"), "compose -p p exec -T api sh -c x"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := strings.Join(tc.got, " "); got != tc.want {
				t.Fatalf("got  %q\nwant %q", got, tc.want)
			}
		})
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
