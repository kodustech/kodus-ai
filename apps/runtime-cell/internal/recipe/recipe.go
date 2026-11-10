// Package recipe is the environment recipe (docs §6): how a checkout boots,
// in the format Runo reads from .kodus/workspace.yaml. The product sends the
// default branch's recipe in claim.acquire and the agent writes it into the
// checkout at Path, over the PR's copy; the drivers read it from there.
//
// The package knows the format and the rules every cell enforces (no files
// copied from a developer's machine, no secrets, paths inside the repo). What
// one driver does or does not support is that driver's business.
package recipe

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"go.yaml.in/yaml/v3"
)

// Path is where a checkout carries its recipe.
const Path = ".kodus/workspace.yaml"

// DefaultHealthTimeout bounds the boot's waits when the recipe sets none.
const DefaultHealthTimeout = 2 * time.Minute

// MaxHealthTimeout is the most a boot waits, whatever the recipe says
// (MAX_HEALTH_TIMEOUT_SECONDS in libs/runtime/protocol/recipe.ts, held to
// the same value by the recipe contract). A longer health_timeout is read as
// this one, not refused: a Runo recipe may wait longer on a developer's VM,
// and boots in a cell all the same.
const MaxHealthTimeout = 900 * time.Second

// Recipe is .kodus/workspace.yaml. Every key of docs §6 is known, so an
// unknown key is an error. Resource nodes are validated and normalized;
// fields not acted on are retained so the setup can identify them.
type Recipe struct {
	fakeServices    []FakeService
	resourceSize    *ResourceSize
	egressHosts     []string
	legacyUnapplied []string
	Version         int      `yaml:"version"`
	Setup           []string `yaml:"setup"`
	Services        Services `yaml:"services"`
	Data            Data     `yaml:"data"`
	Files           *struct {
		Copy []string `yaml:"copy"`
	} `yaml:"files"`
	Validate ValidationChecks `yaml:"validate"`
	Limits   yaml.Node        `yaml:"limits"`
	Size     yaml.Node        `yaml:"size"`
	Fakes    yaml.Node        `yaml:"fakes"`
	Flags    yaml.Node        `yaml:"flags"`
	LLM      yaml.Node        `yaml:"llm"`
	Egress   yaml.Node        `yaml:"egress"`
	UI       yaml.Node        `yaml:"ui"`
	// Expose is Runo's: how a developer's VM is reached from outside
	// (mode, domain, hostname). Nothing in a cell is reachable from
	// outside, so the cell reads it and does nothing with it; the ports the
	// probes reach are services.expose.
	Expose yaml.Node `yaml:"expose"`
}

type Services struct {
	Compose Compose       `yaml:"compose"`
	Expose  []ExposedPort `yaml:"expose"`
	Needs   yaml.Node     `yaml:"needs"`
}

// Compose is how the compose project is found and when it counts as up.
type Compose struct {
	// Files merge in order, like docker compose -f a -f b.
	Files []string `yaml:"files"`
	// File is Runo's one-file form of Files; Parse moves it into Files.
	File string `yaml:"file"`
	// Profiles are the compose profiles whose services start beside the
	// services that have none, like docker compose --profile.
	Profiles []string `yaml:"profiles"`
	// Public is one service or, in Runo's form, a list whose first entry is
	// the primary (Primary): the service whose health path says the app is
	// up. The others are only public URLs on a Runo VM.
	Public Names `yaml:"public"`
	// PublicPort is Runo's: which published port of the primary its VM
	// serves. The cell probes services.expose and reads it only to keep
	// Runo's rule that it goes with one public service.
	PublicPort    int      `yaml:"public_port"`
	Health        string   `yaml:"health"`
	HealthTimeout Duration `yaml:"health_timeout"`
	// Env is new (not in docs §6): variables every service's container gets
	// (over the compose file's own), and local-docker's compose
	// interpolation. Never secrets; Parse refuses anything that looks like one.
	Env map[string]string `yaml:"env"`
}

// ExposedPort is a port the probes reach, by service.
type ExposedPort struct {
	Service              string `yaml:"service"`
	Port                 int    `yaml:"port"`
	Kind                 string `yaml:"kind"`
	ReadonlyUserFromSeed bool   `yaml:"readonly_user_from_seed"`
}

// Data is how the databases get the state every round starts from.
type Data struct {
	Migrate string `yaml:"migrate"`
	Seed    Seed   `yaml:"seed"`
	// Reset is new: recreate (the default: down -v, up, migrate, seed,
	// ready), reseed (seed and ready only, for a seed that cleans up after
	// itself) or snapshot (the data volumes are copied once the first boot
	// is ready, and every reset copies them back: no migrate, no seed).
	Reset string `yaml:"reset"`
}

// Reset strategies.
const (
	ResetRecreate = "recreate"
	ResetReseed   = "reseed"
	ResetSnapshot = "snapshot"
)

// Seed is a host command (the Runo string form), or a mapping: a command
// run in a service, or a SQL file piped to psql in a postgres service.
type Seed struct {
	Command  string
	Service  string
	SQL      string
	User     string
	Database string
}

// IsZero is true when the recipe seeds nothing.
func (s Seed) IsZero() bool { return s == Seed{} }

func (s *Seed) UnmarshalYAML(n *yaml.Node) error {
	switch n.Kind {
	case yaml.ScalarNode:
		s.Command = n.Value
		return nil
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, v := n.Content[i].Value, n.Content[i+1]
			if v.Kind != yaml.ScalarNode {
				return fmt.Errorf("data.seed.%s must be a string", k)
			}
			switch k {
			case "command":
				s.Command = v.Value
			case "service":
				s.Service = v.Value
			case "sql":
				s.SQL = v.Value
			case "user":
				s.User = v.Value
			case "database":
				s.Database = v.Value
			default:
				return fmt.Errorf("data.seed: unknown field %q", k)
			}
		}
		if s.Service == "" || (s.SQL == "") == (s.Command == "") {
			return errors.New("data.seed: a mapping needs service and exactly one of sql or command")
		}
		return nil
	}
	return errors.New("data.seed must be a string or a mapping")
}

// Names is one name or a list of names.
type Names []string

func (n *Names) UnmarshalYAML(node *yaml.Node) error {
	switch node.Kind {
	case yaml.ScalarNode:
		*n = Names{node.Value}
		return nil
	case yaml.SequenceNode:
		var list []string
		if err := node.Decode(&list); err != nil {
			return err
		}
		*n = list
		return nil
	}
	return errors.New("must be a name or a list of names")
}

// Primary is the public service: the first one listed.
func (c Compose) Primary() string {
	if len(c.Public) == 0 {
		return ""
	}
	return c.Public[0]
}

// Duration is a time with a unit (120s, 10m); a bare number is seconds, as
// in Runo. Zero is a wait the recipe does not set (recipes written before
// durations were checked say health_timeout: 0 for "the default", and must
// still boot); a negative one is a typo (recipeDurationSeconds agrees).
type Duration time.Duration

// maxBareSeconds is the largest bare number of seconds a time.Duration holds.
const maxBareSeconds = math.MaxInt64 / int64(time.Second)

func (d *Duration) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind != yaml.ScalarNode {
		return errors.New("duration must be a scalar")
	}
	v, ok := parseDuration(n.Value)
	if !ok {
		return fmt.Errorf("bad duration %q", n.Value)
	}
	*d = Duration(v)
	return nil
}

// parseDuration reads a bare number of seconds or a Go duration; ok only
// for zero or a positive one a time.Duration holds.
func parseDuration(s string) (time.Duration, bool) {
	if secs, err := strconv.ParseInt(s, 10, 64); err == nil {
		return time.Duration(secs) * time.Second, secs >= 0 && secs <= maxBareSeconds
	}
	v, err := time.ParseDuration(s)
	return v, err == nil && v >= 0
}

// servicesKeys are what services holds. Runo's services mode puts the
// app's own services there (db: { image }, app: { run }); a cell boots a
// compose project only.
var servicesKeys = map[string]bool{"compose": true, "expose": true, "needs": true}

// refuseServicesMode names Runo's services mode before the strict decode
// does, whose "field db not found" says nothing a person can act on.
func refuseServicesMode(b []byte) error {
	var doc struct {
		Services map[string]any `yaml:"services"`
		Validate yaml.Node      `yaml:"validate"`
	}
	if yaml.Unmarshal(b, &doc) != nil {
		return nil // the strict decode reports it
	}
	if !doc.Validate.IsZero() && validationNode(&doc.Validate).Kind != yaml.SequenceNode {
		return errors.New("validate must be a list of named checks")
	}
	keys := make([]string, 0, len(doc.Services))
	for k := range doc.Services {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !servicesKeys[k] {
			return fmt.Errorf("services.%s: a cell boots a compose project (services.compose); Runo's services mode, a service with image or run, does not run in a cell", k)
		}
	}
	return nil
}

// Parse decodes and validates a recipe.
func Parse(b []byte) (*Recipe, error) {
	if err := refuseServicesMode(b); err != nil {
		return nil, fmt.Errorf("recipe: %w", err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	var r Recipe
	if err := dec.Decode(&r); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, errors.New("recipe: empty")
		}
		return nil, fmt.Errorf("recipe: %w", err)
	}
	if err := r.normalize(); err != nil {
		return nil, fmt.Errorf("recipe: %w", err)
	}
	if err := r.validate(); err != nil {
		return nil, fmt.Errorf("recipe: %w", err)
	}
	return &r, nil
}

// normalize turns Runo's short forms into the one form the drivers read.
func (r *Recipe) normalize() error {
	if err := r.normalizeResources(); err != nil {
		return err
	}
	if err := r.normalizeFakes(); err != nil {
		return err
	}
	c := &r.Services.Compose
	if c.File != "" {
		if len(c.Files) > 0 {
			return errors.New("services.compose: file and files together; use one")
		}
		c.Files, c.File = []string{c.File}, ""
	}
	return nil
}

// Load reads the checkout's recipe; nil, nil when it has none.
func Load(checkout string) (*Recipe, error) {
	b, err := os.ReadFile(filepath.Join(checkout, Path))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Parse(b)
}

// HealthTimeout bounds every wait of the boot: the health check, a
// database getting ready for its seed.
func (r *Recipe) HealthTimeout() time.Duration {
	if r.Services.Compose.HealthTimeout > 0 {
		return min(time.Duration(r.Services.Compose.HealthTimeout), MaxHealthTimeout)
	}
	return DefaultHealthTimeout
}

// PublicHTTP is the exposed http port of the public service, the one the
// health path is asked on.
func (r *Recipe) PublicHTTP() (ExposedPort, bool) {
	for _, e := range r.Services.Expose {
		if e.Service == r.Services.Compose.Primary() && e.Kind == "http" {
			return e, true
		}
	}
	return ExposedPort{}, false
}

// SeedsData is true when the recipe migrates or seeds.
func (r *Recipe) SeedsData() bool { return r.Data.Migrate != "" || !r.Data.Seed.IsZero() }

// ResetStrategy is data.reset, recreate when unset.
func (r *Recipe) ResetStrategy() string {
	if r.Data.Reset == "" {
		return ResetRecreate
	}
	return r.Data.Reset
}

// HasBootSteps is true when the recipe asks for commands once its project
// is up: setup, data.migrate or data.seed.
func (r *Recipe) HasBootSteps() bool { return len(r.Setup) > 0 || r.SeedsData() }

// Unapplied are the keys the recipe sets that no cell acts on yet, in the
// order docs §6 lists them. Each cell boots as if they were absent, so the
// product tells the person who wrote them (the setup's recipe step) rather
// than let them think they took effect. libs/runtime/protocol/recipe.ts
// lists the same keys (the recipe contract holds both to it).
//
// Not here: services.needs, which a cell refuses (other repositories must
// boot beside this one, or what runs is not the app); limits and expose,
// which describe a Runo VM (its instance, how it is reached from outside)
// and mean nothing in a cell by design.
func (r *Recipe) Unapplied() []string {
	var out []string
	for _, f := range []struct {
		name string
		node *yaml.Node
	}{
		{"flags", &r.Flags},
		{"llm", &r.LLM}, {"ui", &r.UI},
	} {
		if !f.node.IsZero() {
			out = append(out, f.name)
		}
	}
	return append(out, r.legacyUnapplied...)
}
