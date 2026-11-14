package recipe

import (
	"errors"
	"fmt"
	"maps"
	"regexp"
	"sort"

	"go.yaml.in/yaml/v3"
)

// FakeService is a closed local integration. Only its image and app environment
// come from the trusted recipe; compose privileges are never part of it.
type FakeService struct {
	Kind    string            `json:"kind"`
	Service string            `json:"service"`
	Image   string            `json:"image"`
	Env     map[string]string `json:"env"`
}

func (r *Recipe) FakeServices() []FakeService {
	out := make([]FakeService, len(r.fakeServices))
	for i, f := range r.fakeServices {
		f.Env = maps.Clone(f.Env)
		out[i] = f
	}
	return out
}

// FakeRequirementError is a stable blocker category; no environment value is exposed.
type FakeRequirementError struct{ Code string }

func (e *FakeRequirementError) Error() string {
	return "recipe: fake images require an explicit supported repository@sha256 digest; replace the legacy alias with an immutable pin"
}

func (r *Recipe) RequirePinnedFakes() error {
	for _, f := range r.fakeServices {
		if f.Image == "stripe-mock" || f.Image == "mailpit" {
			return &FakeRequirementError{Code: "fake_image_pin_required"}
		}
	}
	return nil
}

var fakePins = map[string]*regexp.Regexp{
	"stripe": regexp.MustCompile(`^stripe/stripe-mock@sha256:[a-f0-9]{64}$`),
	"email":  regexp.MustCompile(`^axllent/mailpit@sha256:[a-f0-9]{64}$`),
}

func fakeNode(n *yaml.Node) (*yaml.Node, error) {
	for depth := 0; n != nil && n.Kind == yaml.AliasNode; depth++ {
		if depth == 16 {
			return nil, errors.New("fakes: excessive alias depth")
		}
		n = n.Alias
	}
	if n == nil {
		return nil, errors.New("fakes: invalid alias")
	}
	return n, nil
}
func (r *Recipe) normalizeFakes() error {
	if r.Fakes.IsZero() {
		return nil
	}
	node, err := fakeNode(&r.Fakes)
	if err != nil {
		return err
	}
	raw, err := fields(node, "stripe", "email")
	if err != nil {
		return fmt.Errorf("fakes: %w", err)
	}
	values := maps.Clone(r.Services.Compose.Env)
	if values == nil {
		values = map[string]string{}
	}
	for _, kind := range []string{"email", "stripe"} {
		n := raw[kind]
		if n == nil {
			continue
		}
		n, err = fakeNode(n)
		if err != nil {
			return err
		}
		service := "stripe-mock"
		if kind == "email" {
			service = "mailpit"
		}
		f := FakeService{Kind: kind, Service: service, Image: service, Env: map[string]string{}}
		var enabled bool
		if n.Kind != yaml.ScalarNode || n.Tag != "!!bool" || n.Decode(&enabled) != nil || !enabled {
			descriptor, e := fields(n, "image", "env")
			if e != nil {
				return fmt.Errorf("fakes.%s: %w", kind, e)
			}
			image, e := fakeNode(descriptor["image"])
			if e != nil || image.Tag != "!!str" {
				return fmt.Errorf("fakes.%s.image: required string", kind)
			}
			f.Image = image.Value
			if f.Image != service && !fakePins[kind].MatchString(f.Image) {
				return fmt.Errorf("fakes.%s.image: use the supported repository pinned by sha256 or its legacy alias", kind)
			}
			if env := descriptor["env"]; env != nil {
				env, e = fakeNode(env)
				if e != nil {
					return e
				}
				if env.Kind != yaml.MappingNode || len(env.Content) > 64 {
					return fmt.Errorf("fakes.%s.env: at most 32 entries in a mapping", kind)
				}
				for i := 0; i < len(env.Content); i += 2 {
					key, value := env.Content[i], env.Content[i+1]
					value, e = fakeNode(value)
					if e != nil {
						return e
					}
					if key.Value == "__proto__" || key.Value == "constructor" || key.Value == "prototype" {
						return fmt.Errorf("fakes.%s.env: reserved environment name", kind)
					}
					if key.Tag != "!!str" || value.Tag != "!!str" || len(key.Value) > 128 || len(value.Value) > 2048 {
						return fmt.Errorf("fakes.%s.env: string names/values required within bounds", kind)
					}
					if _, exists := f.Env[key.Value]; exists {
						return fmt.Errorf("fakes.%s.env: duplicate name", kind)
					}
					f.Env[key.Value] = value.Value
				}
			}
		}
		if err := validateEnvironment(f.Env, "fakes."+kind+".env"); err != nil {
			return err
		}
		keys := make([]string, 0, len(f.Env))
		for k := range f.Env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, key := range keys {
			value := f.Env[key]
			if prior, exists := values[key]; exists && prior != value {
				return fmt.Errorf("fakes: conflicting application environment %s", key)
			}
			values[key] = value
		}
		r.fakeServices = append(r.fakeServices, f)
	}
	return nil
}
