package recipe

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Bounds on the lists a recipe carries.
const (
	MaxComposeFiles = 8
	MaxProfiles     = 16
	MaxPublic       = 16
	MaxExposed      = 32
	maxHealthLen    = 512
)

var (
	envName      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	profileName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
	serviceName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
	healthPath   = regexp.MustCompile(`^/[A-Za-z0-9._~/?=&%-]*$`)
	secretName   = regexp.MustCompile(`(?i)(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)`)
	secretValue  = regexp.MustCompile(`(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9_-]{16,}|sk_live_|AKIA[0-9A-Z]{16}|xox[abpr]-|-----BEGIN)`)
	exposedKinds = map[string]bool{"http": true, "postgres": true, "mysql": true, "grpc": true}
	// testValues are the values Kodus writes when a fix gives a variable a
	// test value (libs/runtime/blockers/catalog.ts testValueFor): they name
	// themselves, so a name that looks like a secret may hold one, and an
	// app that only needs SESSION_SECRET set boots without a secret on the
	// machine (ADR-008). Any other value under such a name is refused.
	testValues = map[string]bool{"kodus-test-value": true, "http://kodus-fake.invalid": true}
)

// The env names a recipe never sets, because they change what runs rather
// than what the app is configured with: which program a name resolves to
// (PATH), what the dynamic linker or a language runtime loads before the
// program (LD_*, DYLD_*, NODE_OPTIONS, JAVA_TOOL_OPTIONS, ...), what a shell
// runs on start (BASH_ENV, ENV), and how docker and compose read the project
// (DOCKER_*, COMPOSE_*), which the cell decides. None of them is app
// configuration, and a driver that hands the env to a process on the cell
// (local-docker gives it to setup, migrate and seed) must not pass them, so
// every cell refuses them here, before any driver sees the recipe.
var (
	controlEnvPrefixes = []string{"LD_", "DYLD_", "DOCKER_", "COMPOSE_"}
	controlEnvNames    = map[string]bool{
		"PATH": true, "IFS": true, "BASH_ENV": true, "ENV": true, "PROMPT_COMMAND": true, "SHELLOPTS": true, "BASHOPTS": true,
		"NODE_OPTIONS": true, "NODE_PATH": true,
		"PYTHONSTARTUP": true, "PYTHONPATH": true, "PYTHONHOME": true,
		"PERL5OPT": true, "PERL5LIB": true, "PERLLIB": true, "RUBYOPT": true, "RUBYLIB": true,
		"JAVA_TOOL_OPTIONS": true, "_JAVA_OPTIONS": true, "JDK_JAVA_OPTIONS": true,
		"GCONV_PATH": true,
	}
)

func isControlEnv(name string) bool {
	n := strings.ToUpper(name)
	if controlEnvNames[n] {
		return true
	}
	for _, p := range controlEnvPrefixes {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	return false
}

// validate holds the rules every cell enforces. Each check is its own
// function so a rule reads, and is tested, on its own.
func (r *Recipe) validate() error {
	for _, check := range []func(*Recipe) error{
		checkVersion,
		refuseCopiedFiles,
		checkComposeFiles,
		checkProfiles,
		checkPublic,
		refuseSecretsInEnv,
		checkExposedPorts,
		checkHealth,
		checkData,
	} {
		if err := check(r); err != nil {
			return err
		}
	}
	return nil
}

func checkVersion(r *Recipe) error {
	if r.Version != 1 {
		return fmt.Errorf("version must be 1, got %d", r.Version)
	}
	return nil
}

// files.copy brings files from the developer's machine (Runo's .env): in a
// cell nothing comes from anyone's machine.
func refuseCopiedFiles(r *Recipe) error {
	if r.Files != nil && len(r.Files.Copy) > 0 {
		return errors.New("files.copy is refused in a cell: env files never go to the machine; use a fake")
	}
	return nil
}

func checkComposeFiles(r *Recipe) error {
	files := r.Services.Compose.Files
	if len(files) > MaxComposeFiles {
		return fmt.Errorf("services.compose.files: at most %d files", MaxComposeFiles)
	}
	for _, f := range files {
		if err := insideRepo("services.compose.files", f); err != nil {
			return err
		}
	}
	return nil
}

func checkProfiles(r *Recipe) error {
	ps := r.Services.Compose.Profiles
	if len(ps) > MaxProfiles {
		return fmt.Errorf("services.compose.profiles: at most %d", MaxProfiles)
	}
	for _, p := range ps {
		if !profileName.MatchString(p) {
			return fmt.Errorf("services.compose.profiles: bad profile %q", p)
		}
	}
	return nil
}

// Runo's rules for public and public_port, so a recipe one tool takes the
// other takes too.
func checkPublic(r *Recipe) error {
	c := r.Services.Compose
	if len(c.Public) > MaxPublic {
		return fmt.Errorf("services.compose.public: at most %d services", MaxPublic)
	}
	seen := map[string]bool{}
	for _, s := range c.Public {
		if !serviceName.MatchString(s) {
			return fmt.Errorf("services.compose.public: bad service %q", s)
		}
		if seen[s] {
			return fmt.Errorf("services.compose.public: %s twice", s)
		}
		seen[s] = true
	}
	if c.PublicPort != 0 {
		if len(c.Public) > 1 {
			return errors.New("services.compose.public_port cannot be used with a list of public services")
		}
		if c.PublicPort < 1 || c.PublicPort > 65535 {
			return fmt.Errorf("services.compose.public_port: bad port %d", c.PublicPort)
		}
	}
	return nil
}

func refuseSecretsInEnv(r *Recipe) error {
	return validateEnvironment(r.Services.Compose.Env, "services.compose.env")
}

func validateEnvironment(env map[string]string, prefix string) error {
	for k, v := range env {
		if !envName.MatchString(k) {
			return fmt.Errorf("%s: bad name %q", prefix, k)
		}
		if isControlEnv(k) {
			return fmt.Errorf("%s.%s changes what runs, not how the app is configured; a recipe never sets it", prefix, k)
		}
		if (secretName.MatchString(k) && !testValues[v]) || secretValue.MatchString(v) {
			return fmt.Errorf("%s.%s looks like a secret; secrets never go in the recipe", prefix, k)
		}
		if strings.ContainsAny(v, "\n\r") {
			return fmt.Errorf("%s.%s has a newline", prefix, k)
		}
	}
	return nil
}

func checkExposedPorts(r *Recipe) error {
	if len(r.Services.Expose) > MaxExposed {
		return fmt.Errorf("services.expose: at most %d entries", MaxExposed)
	}
	seen := map[string]bool{}
	for i, e := range r.Services.Expose {
		key := e.Service + "/" + strconv.Itoa(e.Port)
		switch {
		case e.Service == "":
			return fmt.Errorf("services.expose[%d]: service required", i)
		case e.Port < 1 || e.Port > 65535:
			return fmt.Errorf("services.expose[%d]: bad port %d", i, e.Port)
		case !exposedKinds[e.Kind]:
			return fmt.Errorf("services.expose[%d]: kind %q is not http, postgres, mysql or grpc", i, e.Kind)
		case seen[key]:
			return fmt.Errorf("services.expose[%d]: %s twice", i, key)
		}
		seen[key] = true
	}
	return nil
}

// The health path is asked on the public service's http port, so both
// must be there.
func checkHealth(r *Recipe) error {
	h := r.Services.Compose.Health
	if h == "" {
		return nil
	}
	if !healthPath.MatchString(h) || len(h) > maxHealthLen {
		return fmt.Errorf("services.compose.health %q must be a path", h)
	}
	if _, ok := r.PublicHTTP(); !ok {
		return errors.New("services.compose.health needs services.compose.public with an http entry in services.expose")
	}
	return nil
}

func checkData(r *Recipe) error {
	if s := r.Data.Seed; s.SQL != "" {
		if err := insideRepo("data.seed.sql", s.SQL); err != nil {
			return err
		}
	}
	switch r.Data.Reset {
	case "", ResetRecreate, ResetReseed, ResetSnapshot:
		return nil
	}
	return fmt.Errorf("data.reset %q is not %s, %s or %s", r.Data.Reset, ResetRecreate, ResetReseed, ResetSnapshot)
}

func insideRepo(field, p string) error {
	if p == "" || !filepath.IsLocal(p) {
		return fmt.Errorf("%s: %q must be a path inside the repo", field, p)
	}
	return nil
}
