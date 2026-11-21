package compose

import (
	"errors"
	"fmt"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// FakeComposeError describes a closed configuration refusal, never an env value.
type FakeComposeError struct{ Code string }

func (e *FakeComposeError) Error() string {
	return "compose: declared fake conflicts with the application's service or environment configuration"
}

// AddRecipeFakes turns a trusted base recipe into ordinary compose services.
// It validates the entire change before applying it. The existing canonical
// sandbox and per-claim budgets remain authoritative when the project starts.
func (p *Project) AddRecipeFakes(rec *recipe.Recipe) error {
	if rec == nil || len(rec.FakeServices()) == 0 {
		return nil
	}
	if err := rec.RequirePinnedFakes(); err != nil {
		return err
	}
	fakes := rec.FakeServices()
	original := p.ServiceNames()
	if len(original) == 0 {
		return errors.New("compose: the project has no application services")
	}
	for _, fake := range fakes {
		if p.HasService(fake.Service) {
			return &FakeComposeError{Code: "fake_service_collision"}
		}
	}
	env := map[string]string{}
	for _, fake := range fakes {
		for k, v := range fake.Env {
			env[k] = strings.ReplaceAll(v, "$", "$$")
		}
	}
	environment := map[string]map[string]any{}
	depends := map[string]map[string]any{}
	for _, name := range original {
		svc := p.Service(name)
		if svc == nil {
			return fmt.Errorf("compose: service %q is not a mapping", name)
		}
		merged, err := environmentMap(svc["environment"])
		if err != nil {
			return fmt.Errorf("compose: service %q environment is invalid", name)
		}
		for k, v := range env {
			if prior, present := merged[k]; present && prior != v {
				return &FakeComposeError{Code: "fake_environment_collision"}
			}
			merged[k] = v
		}
		environment[name] = merged
		deps, err := fakeDependencies(svc["depends_on"])
		if err != nil {
			return err
		}
		for _, fake := range fakes {
			deps[fake.Service] = map[string]any{"condition": "service_healthy"}
		}
		depends[name] = deps
	}
	for _, name := range original {
		svc := p.Service(name)
		if len(env) > 0 {
			svc["environment"] = environment[name]
		}
		svc["depends_on"] = depends[name]
	}
	for _, fake := range fakes {
		svc := map[string]any{"image": fake.Image}
		if fake.Kind == "stripe" {
			svc["healthcheck"] = map[string]any{"test": []any{"CMD-SHELL", "wget -q -O /dev/null --header='Authorization: Bearer sk_test_123' http://127.0.0.1:12111/v1/charges"}, "interval": "1s", "timeout": "1s", "retries": 30}
		} else {
			svc["environment"] = map[string]any{"MP_MAX_MESSAGES": "500"}
			svc["healthcheck"] = map[string]any{"test": []any{"CMD", "/mailpit", "readyz"}, "interval": "1s", "timeout": "1s", "retries": 30}
		}
		p.services()[fake.Service] = svc
	}
	return nil
}

func fakeDependencies(raw any) (map[string]any, error) {
	out := map[string]any{}
	switch value := raw.(type) {
	case nil:
	case map[string]any:
		for name, condition := range value {
			out[name] = condition
		}
	case []any:
		for _, entry := range value {
			name, ok := entry.(string)
			if !ok {
				return nil, errors.New("compose: depends_on list requires service names")
			}
			out[name] = map[string]any{"condition": "service_started"}
		}
	default:
		return nil, errors.New("compose: depends_on is not a mapping or list")
	}
	return out, nil
}
