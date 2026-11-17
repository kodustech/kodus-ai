package k8ssandbox

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/checkoutfs"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// An exec step (setup commands, the agent's look around, the repository's
// tests) runs in the workload's public service container over pods/exec:
// the pod the PR's code already runs in, on the RuntimeClass, with the
// app's toolchain and its services by name. Nothing of the request reaches
// a shell in the cell.

// ErrNoExecService means the project names no service exec steps could run in.
var ErrNoExecService = errors.New("k8ssandbox: no service to run commands in (the recipe names no public service and the project has more than one)")

// execLine runs the command from dir with the request's env, under
// timeout(1) when the image has it: the cell's deadline on the exec stream
// does not stop what the command started. $1 dir, $2 seconds, $3 the
// command line, the rest NAME=value: positional, never spliced.
const execLine = `cd -- "$1" || exit 126; secs="$2"; line="$3"; shift 3; if command -v timeout >/dev/null 2>&1; then exec env "$@" timeout -s KILL "$secs" /bin/sh -c "$line"; fi; exec env "$@" /bin/sh -c "$line"`

// execGrace is how much longer the stream may run than the command.
const execGrace = 5 * time.Second

var envKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

// Exec runs the request in the workload's public service. cwd is relative
// to the service's working directory and stays inside it.
func (d *Driver) Exec(ctx context.Context, ref driver.MachineRef, req kodyexec.Request) (kodyexec.Result, error) {
	if d.cfg.Env == nil {
		return kodyexec.Result{}, errNoRuns
	}
	if _, err := d.holderFacts(ctx, ref); err != nil {
		return kodyexec.Result{}, err
	}
	if req.Repository != "" {
		return kodyexec.Result{}, fmt.Errorf("%w: a command on another repository of the workspace (exec.repository) is not wired on Kubernetes yet", driver.ErrUnsupported)
	}
	st := d.envs.get(ref.MachineID)
	if st.exec == nil {
		return kodyexec.Result{}, ErrNoExecService
	}
	dir, err := inside(st.exec.dir, req.Cwd)
	if err != nil {
		return kodyexec.Result{}, err
	}
	for _, kv := range req.Env {
		if !envKey.MatchString(kv) {
			return kodyexec.Result{}, fmt.Errorf("k8ssandbox: env %q is not KEY=VALUE", strings.SplitN(kv, "=", 2)[0])
		}
	}
	return d.execIn(ctx, envTarget{pod: st.exec.pod, container: st.exec.container, dir: dir}, req, nil), nil
}

// execIn runs req in at, from at.dir, bounded and masked as kody-exec does.
func (d *Driver) execIn(ctx context.Context, at envTarget, req kodyexec.Request, stdin []byte) kodyexec.Result {
	e := d.cfg.Env
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = time.Minute
	}
	secs := strconv.FormatInt(int64((timeout+time.Second-1)/time.Second), 10)
	argv := append([]string{"/bin/sh", "-c", execLine, "kody-exec", at.dir, secs, req.ShellLine()}, req.Env...)
	cctx, cancel := context.WithTimeout(ctx, timeout+execGrace)
	defer cancel()
	start := d.cfg.Now()
	res, err := e.Exec.RunCommand(cctx, e.Namespace, at.pod, at.container, argv, stdin, kodyexec.MaxStream)
	out := kodyexec.Result{
		ExitCode: res.ExitCode, Stdout: kodyexec.MaskSecrets(string(res.Stdout), req.Secrets), Stderr: kodyexec.MaskSecrets(string(res.Stderr), req.Secrets),
		Truncated: res.Truncated, DurationMs: d.cfg.Now().Sub(start).Milliseconds(),
	}
	switch {
	case cctx.Err() != nil, err == nil && res.ExitCode == 137 && out.DurationMs >= timeout.Milliseconds():
		// The deadline, in the pod (timeout -s KILL) or on the stream.
		out.TimedOut, out.ExitCode = true, kodyexec.TimeoutExitCode
	case err != nil:
		out.ExitCode, out.Stderr = 127, kodyexec.MaskSecrets(err.Error(), req.Secrets)
	case res.ExitCode < 0:
		out.ExitCode = 127
	}
	return out
}

// inside joins rel to base, refusing anything that leaves base.
func inside(base, rel string) (string, error) {
	if rel == "" {
		return base, nil
	}
	if path.IsAbs(rel) {
		return "", fmt.Errorf("k8ssandbox: cwd %q is not relative to the workspace", rel)
	}
	p := path.Join(base, rel)
	if p != base && !strings.HasPrefix(p, strings.TrimSuffix(base, "/")+"/") {
		return "", fmt.Errorf("k8ssandbox: cwd %q leaves the workspace", rel)
	}
	return p, nil
}

// The recipe's boot steps (setup, data.migrate, data.seed) run in the
// project once it is up, after every Up, in that order, as on docker-gvisor:
// setup and migrate and a seed command in the public service, a seed
// mapping in the service it names, a seed SQL file piped to psql there. The
// golden copy is taken before any of them (Up's step 2), so every round
// runs them on the database's first-start data.
const (
	recipeStepTimeout = 10 * time.Minute
	maxSeedBytes      = 64 << 20
	seedPoll          = 200 * time.Millisecond
)

// seedScript waits for postgres to answer on 127.0.0.1, then pipes stdin to
// psql. $1 user, $2 database, $3 polls (docker-gvisor's).
const seedScript = `n=0; until pg_isready -q -h 127.0.0.1 -U "$1" -d "$2"; do n=$((n+1)); if [ "$n" -ge "$3" ]; then echo "postgres never answered on 127.0.0.1" >&2; exit 3; fi; sleep 0.2; done; exec psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$1" -d "$2"`

// RunRecipe runs the recipe's boot steps in the project the last Up brought up.
func (d *Driver) RunRecipe(ctx context.Context, ref driver.MachineRef, projectDir string, output func(line string)) error {
	if d.cfg.Env == nil {
		return errNoRuns
	}
	rec, err := recipe.Load(projectDir)
	if err != nil {
		return driver.WorkloadRecipeRefused(fmt.Errorf("k8ssandbox: %w", err))
	}
	if rec == nil || !rec.HasBootSteps() {
		return nil
	}
	st := d.envs.get(ref.MachineID)
	say := func(l string) {
		if output != nil {
			output(l)
		}
	}
	step := func(at *envTarget, step, field, command string, stdin []byte, argv ...string) error {
		if at == nil {
			return &driver.RecipeStepError{Step: step, Field: field, Err: ErrNoExecService}
		}
		say("$ " + field + ": " + command)
		req := kodyexec.Request{Command: command, TimeoutMs: recipeStepTimeout.Milliseconds()}
		var res kodyexec.Result
		if argv != nil {
			res = d.execArgv(ctx, *at, argv, stdin)
		} else {
			res = d.execIn(ctx, *at, req, stdin)
		}
		for _, out := range []string{res.Stdout, res.Stderr} {
			for _, l := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
				if l != "" {
					say(l)
				}
			}
		}
		switch {
		case res.TimedOut:
			return &driver.RecipeStepError{Step: step, Field: field, Err: fmt.Errorf("%q ran past %s", command, recipeStepTimeout)}
		case res.ExitCode != 0:
			return &driver.RecipeStepError{Step: step, Field: field, Err: fmt.Errorf("%q exited %d: %s", command, res.ExitCode, lastLines(res.Stderr, res.Stdout))}
		}
		return nil
	}
	for i, c := range rec.Setup {
		if err := step(st.exec, "setup", fmt.Sprintf("setup[%d]", i), c, nil); err != nil {
			return err
		}
	}
	if rec.Data.Migrate != "" {
		if err := step(st.exec, "migrate", "data.migrate", rec.Data.Migrate, nil); err != nil {
			return err
		}
	}
	s := rec.Data.Seed
	switch {
	case s.IsZero():
	case s.Service == "":
		return step(st.exec, "seed", "data.seed", s.Command, nil)
	default:
		t, ok := st.targets[s.Service]
		if !ok {
			return &driver.RecipeStepError{Step: "seed", Field: "data.seed", Err: fmt.Errorf("service %q is not in the compose project", s.Service)}
		}
		if s.Command != "" {
			return step(&t, "seed", "data.seed", s.Command, nil)
		}
		sql, err := checkoutfs.Read(projectDir, s.SQL, maxSeedBytes)
		if err != nil {
			return &driver.RecipeStepError{Step: "seed", Field: "data.seed.sql", Err: err}
		}
		user, db := s.User, s.Database
		if user == "" {
			user = "postgres"
		}
		if db == "" {
			db = user
		}
		polls := strconv.Itoa(max(int(rec.HealthTimeout()/seedPoll), 1))
		return step(&t, "seed", "data.seed", s.SQL+" into "+s.Service, sql, "/bin/sh", "-c", seedScript, "kodus-seed", user, db, polls)
	}
	return nil
}

// execArgv runs a fixed argv in at with stdin, under the recipe step's bound.
func (d *Driver) execArgv(ctx context.Context, at envTarget, argv []string, stdin []byte) kodyexec.Result {
	e := d.cfg.Env
	cctx, cancel := context.WithTimeout(ctx, recipeStepTimeout)
	defer cancel()
	res, err := e.Exec.RunCommand(cctx, e.Namespace, at.pod, at.container, argv, stdin, kodyexec.MaxStream)
	out := kodyexec.Result{ExitCode: res.ExitCode, Stdout: string(res.Stdout), Stderr: string(res.Stderr), Truncated: res.Truncated}
	switch {
	case cctx.Err() != nil:
		out.TimedOut, out.ExitCode = true, kodyexec.TimeoutExitCode
	case err != nil:
		out.ExitCode, out.Stderr = 127, err.Error()
	}
	return out
}

func lastLines(stderr, stdout string) string {
	out := strings.TrimSpace(stderr)
	if out == "" {
		out = strings.TrimSpace(stdout)
	}
	if len(out) > 1000 {
		out = "..." + out[len(out)-1000:]
	}
	if out == "" {
		return "no output"
	}
	return out
}

// ServiceLogs is what the claim's services logged in [since, until], as the
// kubelet timed it, the last maxLines of each service at most.
func (d *Driver) ServiceLogs(ctx context.Context, claimID string, ref driver.MachineRef, since, until time.Time, maxLines int) ([]driver.ServiceLogLine, error) {
	if d.cfg.Env == nil {
		return nil, errNoRuns
	}
	f, err := d.holderFacts(ctx, ref)
	if err != nil {
		return nil, err
	}
	if f.claim != claimID {
		return nil, fmt.Errorf("%w: machine %s is not claim %s's", driver.ErrNotOwned, ref.MachineID, claimID)
	}
	st := d.envs.get(ref.MachineID)
	if st.plan == nil {
		return nil, nil
	}
	e := d.cfg.Env
	var out []driver.ServiceLogLine
	for _, s := range st.plan.Services {
		raw, err := e.API.PodLogs(ctx, e.Namespace, s.PodName, s.Container, since, maxLines)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		sc := bufio.NewScanner(bytes.NewReader(raw))
		sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
		for sc.Scan() {
			ts, text, ok := strings.Cut(sc.Text(), " ")
			at, err := time.Parse(time.RFC3339Nano, ts)
			if !ok || err != nil || at.Before(since) || (!until.IsZero() && at.After(until)) {
				continue
			}
			out = append(out, driver.ServiceLogLine{Service: s.Name, At: at, Text: text})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out, nil
}
