//go:build dockersmoke

package dockergvisor

import (
	"context"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
)

// The warm fork reset of the sample app under runsc, through the real driver
// and the host's Docker, as the agent runs it: Up and the recipe's steps,
// then per round a spare booted (BootSpare) while the round "runs", and the
// reset a swap (TakeSpare). Same setup as TestSmokeResetSampleApp:
//
//	KGR_APP_DIR=.../sample-app/app KGR_APP_IMAGE=kr-reset-smoke/app:local KGR_RESETS=8 \
//	  go test -tags dockersmoke -run TestSmokeWarmForkSampleApp -v ./internal/drivers/dockergvisor/
//
// After each swap the round must start as the first boot did (the seeded
// rows, nothing an earlier round wrote, a new app process), on the other
// address block, with the used copy gone. It logs each spare's boot, each
// swap, and the memory the two copies hold while both run (docker stats).
// KGR_BASELINE=1 also resets a second machine today's way, in turns, for a
// before and after on the same host.
func TestSmokeWarmForkSampleApp(t *testing.T) {
	dir, file := smokeApp(t)
	warmForkRounds(t, dir, file)
}

// The same with a project closer to kodus-ai's in what a swap ends: the
// sample app three times over, postgres, mongo and redis, each database on
// a named volume. (mongo:8.0 and redis:7-alpine pulled first; rabbitmq's
// stock image exits under the sandbox's cap_drop ALL here.)
func TestSmokeWarmForkSixServices(t *testing.T) {
	dir, file := smokeApp(t)
	image := os.Getenv("KGR_APP_IMAGE")
	app := func(name string) string {
		return "    " + name + ":\n        image: " + image + "\n        environment:\n            DATABASE_URL: postgres://shop:shop@db:5432/shop\n        depends_on:\n            db:\n                condition: service_healthy\n" +
			"        healthcheck:\n            test: ['CMD', 'node', '-e', \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"]\n            interval: 2s\n            retries: 30\n"
	}
	extra := app("worker") + app("webhooks") +
		"    mongo:\n        image: mongo:8.0\n        volumes: [mongodata:/data/db]\n        healthcheck:\n            test: ['CMD', 'mongosh', '--quiet', '--eval', 'db.runCommand({ping:1})']\n            interval: 2s\n            retries: 60\n" +
		"    redis:\n        image: redis:7-alpine\n        volumes: [redisdata:/data]\n        healthcheck:\n            test: ['CMD', 'redis-cli', 'ping']\n            interval: 2s\n            retries: 60\n"
	file = []byte(strings.Replace(string(file), "services:\n", "services:\n"+extra, 1) + "volumes:\n    mongodata: {}\n    redisdata: {}\n")
	warmForkRounds(t, dir, file)
}

func warmForkRounds(t *testing.T, dir string, file []byte) {
	t.Helper()
	m := newSmokeMachineWith(t, dir, file, false, ordersState, func(c *Config) { c.WarmForkReset = true })
	probe := newSmokeProbe(t, networkName(m.claim))
	var before *smokeMachine
	if os.Getenv("KGR_BASELINE") != "" {
		before = newSmokeMachine(t, dir, file, false, ordersState)
	}
	ctx := context.Background()
	var boots, swaps []int64
	for i := range smokeResets() {
		project, block := m.d.projectOf(m.ref.MachineID)
		row := "round-" + strconv.Itoa(i)
		psql(t, project, "INSERT INTO orders (item, quantity) VALUES ('"+row+"', 1)")
		var told []string
		at := time.Now()
		if err := m.d.BootSpare(ctx, driver.UpRequest{Ref: m.ref, Compose: m.file, ProjectDir: m.dir}, func(s []string) error { told = s; return nil }); err != nil {
			t.Fatalf("spare %d: %v", i, err)
		}
		boots = append(boots, time.Since(at).Milliseconds())
		spare := projectName(m.ref.MachineID, 1-block)
		t.Logf("spare %d: %s booted in %d ms at %v; memory while both run: %s", i, spare, boots[len(boots)-1], told, projectMemory(t, project, spare))
		at = time.Now()
		sources, ok, err := m.d.TakeSpare(ctx, m.ref)
		if err != nil || !ok {
			t.Fatalf("swap %d: ok %v err %v", i, ok, err)
		}
		swaps = append(swaps, time.Since(at).Milliseconds())
		tm, _ := m.d.BootTiming(m.claim)
		t.Logf("swap %d: %d ms (driver total=%d down=%d), sources %v", i, swaps[len(swaps)-1], tm.TotalMs, tm.DownMs, sources)
		now, _ := m.d.projectOf(m.ref.MachineID)
		if now != spare {
			t.Fatalf("swap %d: the machine runs %s, not the spare %s", i, now, spare)
		}
		// Killed by the swap (SIGKILL: kill returns before the sandboxes
		// exit); down with its volumes right after.
		for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
			out, _ := exec.Command("docker", "ps", "-q", "--filter", "label=com.docker.compose.project="+project).Output()
			if len(strings.TrimSpace(string(out))) == 0 {
				t.Logf("swap %d: the used copy stopped running %d ms after the swap began", i, time.Since(at).Milliseconds())
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("swap %d: the used copy %s still runs", i, project)
			}
		}
		if err := m.d.waitDrained(ctx, m.ref.MachineID); err != nil {
			t.Fatal(err)
		}
		if out, _ := exec.Command("docker", "ps", "-aq", "--filter", "label=com.docker.compose.project="+project).Output(); len(strings.TrimSpace(string(out))) > 0 {
			t.Fatalf("swap %d: the used copy %s outlived its down", i, project)
		}
		if out, _ := exec.Command("docker", "volume", "ls", "-q", "--filter", "label=com.docker.compose.project="+project).Output(); len(strings.TrimSpace(string(out))) > 0 {
			t.Fatalf("swap %d: the used copy's volumes outlived its down: %s", i, out)
		}
		if got := m.state(t, now); got != m.first {
			t.Fatalf("swap %d: %s, the first boot had %s", i, got, m.first)
		}
		if got := psql(t, now, "SELECT count(*) FROM orders WHERE item LIKE 'round-%'"); got != "0" {
			t.Fatalf("swap %d: %s rows of earlier rounds are back", i, got)
		}
		if p := appStarted(t, now); p == m.appPID {
			t.Fatalf("swap %d: the app process is the previous round's", i)
		} else {
			m.appPID = p
		}
		// A gVisor peer on the claim network (the observer's place) reaches
		// the app at its new address.
		target, _ := m.d.Targets(m.ref.MachineID, []observer.Target{{Service: "app", Port: 3000}})
		t.Logf("swap %d: a runsc peer's first answer from %s after %d ms", i, target[0].Address, probe.firstAnswer(t, target[0].Address, at))
		if before != nil {
			before.reset(t, i)
		}
	}
	t.Logf("spare boot ms %v (median %d); swap ms %v (median %d)", boots, median(boots), swaps, median(swaps))
	if before != nil {
		t.Log("today's reset, same host, in turns:")
		before.report(t)
	}
}

// smokeProbe is a runsc container on the claim network that GETs the app,
// as the observer does.
type smokeProbe struct{ name string }

func newSmokeProbe(t *testing.T, network string) smokeProbe {
	t.Helper()
	name := "kr-smoke-probe-" + strconv.FormatInt(time.Now().UnixNano()%1_000_000, 10)
	if out, err := exec.Command("docker", "run", "-d", "--runtime=runsc", "--network", network, "--name", name, "--label", "kr-reset-smoke=1", "alpine:3.20", "sleep", "infinity").CombinedOutput(); err != nil {
		t.Fatalf("probe: %v %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	return smokeProbe{name: name}
}

// firstAnswer is how long after since the probe's first good /health came.
func (p smokeProbe) firstAnswer(t *testing.T, addr string, since time.Time) int64 {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if err := exec.Command("docker", "exec", p.name, "wget", "-q", "-T", "2", "-O", "/dev/null", "http://"+addr+"/health").Run(); err == nil {
			return time.Since(since).Milliseconds()
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no answer from %s", addr)
	return 0
}

func median(v []int64) int64 {
	s := slices.Clone(v)
	slices.Sort(s)
	return s[len(s)/2]
}

// projectMemory is what docker stats says each container of the projects
// holds, and their sum in MiB.
func projectMemory(t *testing.T, projects ...string) string {
	t.Helper()
	var names []string
	for _, p := range projects {
		out, err := exec.Command("docker", "ps", "-q", "--filter", "label=com.docker.compose.project="+p).Output()
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, strings.Fields(string(out))...)
	}
	if len(names) == 0 {
		return "none"
	}
	out, err := exec.Command("docker", append([]string{"stats", "--no-stream", "--format", "{{.Name}}={{.MemUsage}}"}, names...)...).Output()
	if err != nil {
		return "unread: " + err.Error()
	}
	var total float64
	var parts []string
	for _, line := range strings.Fields(string(out)) {
		parts = append(parts, line)
		_, usage, _ := strings.Cut(line, "=")
		used, _, _ := strings.Cut(usage, "/")
		total += mib(strings.TrimSpace(used))
	}
	return strings.Join(parts, " ") + " total=" + strconv.FormatFloat(total, 'f', 1, 64) + "MiB"
}

func mib(s string) float64 {
	for _, u := range []struct {
		suffix string
		mult   float64
	}{{"GiB", 1024}, {"MiB", 1}, {"KiB", 1.0 / 1024}, {"B", 1.0 / (1 << 20)}} {
		if strings.HasSuffix(s, u.suffix) {
			n, _ := strconv.ParseFloat(strings.TrimSuffix(s, u.suffix), 64)
			return n * u.mult
		}
	}
	return 0
}

// newSmokeMachineWith is newSmokeMachine with the driver's configuration
// edited.
func newSmokeMachineWith(t *testing.T, appDir string, file []byte, noGolden bool, state func(*testing.T, string) string, edit func(*Config)) *smokeMachine {
	t.Helper()
	smokeConfigEdit = edit
	defer func() { smokeConfigEdit = nil }()
	return newSmokeMachine(t, appDir, file, noGolden, state)
}

// smokeConfigEdit, when set, edits the next smoke machine's driver
// configuration.
var smokeConfigEdit func(*Config)
