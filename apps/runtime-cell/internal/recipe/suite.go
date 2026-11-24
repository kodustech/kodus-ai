package recipe

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// The suite block (docs/runtime/e2e-suites.md section 3) is the repository's
// own e2e suite, which the worker runs, not the cell: the cell reads it only
// to hold the same verdicts as the worker (libs/runtime/protocol/recipe.ts
// suiteRules, the recipe contract fixtures) and does not list it as unapplied.
const (
	maxSuiteCommandBytes = 1024
	maxSuiteEnv          = 16
	maxSuiteArtifacts    = 8
	maxSuiteIgnore       = 32
	maxSuiteShards       = 16
	maxSuiteTimeout      = 2 * time.Hour
)

// suiteBlock is the decoded block. Unknown keys are refused before the decode
// (checkSuite), so the struct only has to hold the known ones.
type suiteBlock struct {
	Runner  string              `yaml:"runner"`
	Command string              `yaml:"command"`
	Cwd     string              `yaml:"cwd"`
	Specs   string              `yaml:"specs"`
	Shards  *int                `yaml:"shards"`
	Service string              `yaml:"service"`
	Image   string              `yaml:"image"`
	Ignore  []string            `yaml:"ignore"`
	Gate    string              `yaml:"gate"`
	Env     map[string]string   `yaml:"-"`
	Timeout map[string]Duration `yaml:"-"`
	Results struct {
		Junit     string   `yaml:"junit"`
		Artifacts []string `yaml:"artifacts"`
	} `yaml:"-"`
}

// cloudFlag finds a flag that needs Cypress Cloud, whose secret a shard is never given.
func cloudFlag(runner, command string) (string, bool) {
	flags := []string{"--record", "--parallel"}
	if runner == "cypress" {
		flags = append(flags, "--key", "--ci-build-id")
	}
	for _, f := range flags {
		if regexp.MustCompile(`(^|\s)` + regexp.QuoteMeta(f) + `([=\s]|$)`).MatchString(command) {
			return f, true
		}
	}
	return "", false
}

func checkSuite(r *Recipe) error {
	if r.Suite.IsZero() {
		return nil
	}
	n := &r.Suite
	f, err := fields(n, "runner", "command", "cwd", "specs", "shards", "service", "image", "timeout", "env", "results", "baseline", "ignore", "retries", "gate")
	if err != nil {
		return fmt.Errorf("suite: %w", err)
	}
	for _, k := range []string{"runner", "command", "specs"} {
		if f[k] == nil {
			return fmt.Errorf("suite.%s: required", k)
		}
	}
	var s suiteBlock
	for _, k := range []string{"runner", "command", "cwd", "specs", "service", "image", "gate"} {
		if f[k] == nil {
			continue
		}
		var v string
		if f[k].Kind != yaml.ScalarNode || f[k].Tag != "!!str" {
			return fmt.Errorf("suite.%s: must be a string", k)
		}
		v = f[k].Value
		switch k {
		case "runner":
			s.Runner = v
		case "command":
			s.Command = v
		case "cwd":
			s.Cwd = v
		case "specs":
			s.Specs = v
		case "service":
			s.Service = v
		case "image":
			s.Image = v
		case "gate":
			s.Gate = v
		}
	}
	if s.Runner != "cypress" && s.Runner != "playwright" {
		return fmt.Errorf("suite.runner: %q is not cypress or playwright", s.Runner)
	}
	if f["shards"] != nil {
		var v int
		if f["shards"].Decode(&v) != nil || v < 1 || v > maxSuiteShards {
			return fmt.Errorf("suite.shards: use 1 to %d", maxSuiteShards)
		}
	}
	if f["baseline"] != nil {
		var v bool
		if f["baseline"].Decode(&v) != nil {
			return errors.New("suite.baseline: must be true or false")
		}
	}
	if s.Gate != "" && s.Gate != "default" && s.Gate != "strict" {
		return fmt.Errorf("suite.gate: %q is not default or strict", s.Gate)
	}
	if f["ignore"] != nil {
		if f["ignore"].Decode(&s.Ignore) != nil || len(s.Ignore) > maxSuiteIgnore {
			return fmt.Errorf("suite.ignore: a list of at most %d globs", maxSuiteIgnore)
		}
	}
	if f["retries"] != nil {
		rf, err := fields(f["retries"], "main")
		if err != nil {
			return fmt.Errorf("suite.retries: %w", err)
		}
		if m := rf["main"]; m != nil {
			var v int
			if m.Decode(&v) != nil || v < 1 || v > 2 {
				return errors.New("suite.retries.main: use 1 or 2")
			}
		}
	}
	if f["env"] != nil {
		if f["env"].Kind != yaml.MappingNode || f["env"].Decode(&s.Env) != nil {
			return errors.New("suite.env: must be a mapping of plain values")
		}
	}
	if f["timeout"] != nil {
		tf, err := fields(f["timeout"], "shard", "spec", "total")
		if err != nil {
			return fmt.Errorf("suite.timeout: %w", err)
		}
		s.Timeout = map[string]Duration{}
		for k, v := range tf {
			var d Duration
			if v.Decode(&d) != nil {
				return fmt.Errorf("suite.timeout.%s: bad duration %q", k, v.Value)
			}
			s.Timeout[k] = d
		}
	}
	if f["results"] != nil {
		rf, err := fields(f["results"], "junit", "artifacts")
		if err != nil {
			return fmt.Errorf("suite.results: %w", err)
		}
		if v := rf["junit"]; v != nil {
			if v.Kind != yaml.ScalarNode || v.Tag != "!!str" {
				return errors.New("suite.results.junit: must be a string")
			}
			s.Results.Junit = v.Value
		}
		if v := rf["artifacts"]; v != nil {
			if v.Decode(&s.Results.Artifacts) != nil {
				return errors.New("suite.results.artifacts: must be a list of paths")
			}
		}
	}
	return s.validate()
}

func (s *suiteBlock) validate() error {
	if len(s.Command) > maxSuiteCommandBytes {
		return fmt.Errorf("suite.command: at most %d bytes", maxSuiteCommandBytes)
	}
	if flag, bad := cloudFlag(s.Runner, s.Command); bad {
		return fmt.Errorf("suite.command: %s needs Cypress Cloud; a shard is given no record key", flag)
	}
	if s.Runner == "cypress" && !containsSpecs(s.Command) {
		return errors.New("suite.command: a cypress command needs {specs}")
	}
	if len(s.Env) > maxSuiteEnv {
		return fmt.Errorf("suite.env: at most %d entries", maxSuiteEnv)
	}
	if err := validateEnvironment(s.Env, "suite.env"); err != nil {
		return err
	}
	if _, set := s.Env["CYPRESS_RECORD_KEY"]; set {
		return errors.New("suite.env.CYPRESS_RECORD_KEY needs Cypress Cloud; a shard is given no record key")
	}
	if s.Cwd != "" {
		if err := insideRepo("suite.cwd", s.Cwd); err != nil {
			return err
		}
	}
	if err := insideRepo("suite.specs", s.Specs); err != nil {
		return err
	}
	if s.Service != "" && !serviceName.MatchString(s.Service) {
		return fmt.Errorf("suite.service: bad service %q", s.Service)
	}
	if s.Service != "" && s.Image != "" {
		return errors.New("suite: service and image together; use one")
	}
	// An image is not turned into a service by the engine: the environment's compose file holds the services (docs/runtime/e2e-suites.md section 4).
	if s.Image != "" {
		return errors.New("suite.image: not supported yet; add the image as a service of the environment's compose file and name it with suite.service")
	}
	for _, k := range []string{"shard", "spec", "total"} {
		if d, set := s.Timeout[k]; set && (d <= 0 || time.Duration(d) > maxSuiteTimeout) {
			return fmt.Errorf("suite.timeout.%s: use a duration from 1s to 2h", k)
		}
	}
	if s.Results.Junit != "" {
		if err := insideRepo("suite.results.junit", s.Results.Junit); err != nil {
			return err
		}
	}
	if len(s.Results.Artifacts) > maxSuiteArtifacts {
		return fmt.Errorf("suite.results.artifacts: at most %d paths", maxSuiteArtifacts)
	}
	for _, a := range s.Results.Artifacts {
		if err := insideRepo("suite.results.artifacts", a); err != nil {
			return err
		}
	}
	return nil
}

func containsSpecs(command string) bool { return strings.Contains(command, "{specs}") }
