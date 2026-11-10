package recipe

import (
	"errors"
	"strings"
	"unicode"

	"go.yaml.in/yaml/v3"
)

// ValidationChecks are named, explicit internal commands; never boot steps.
// Bounds mirror contracts/recipe-validation.ts (ENV-08, ADR-053).
type ValidationCheck struct {
	Name string `yaml:"name"`
	Run  string `yaml:"run"`
}
type ValidationChecks []ValidationCheck

func validValidationName(v string) bool {
	if len(v) == 0 || len(v) > 128 || strings.TrimFunc(v, func(c rune) bool { return c == '\ufeff' || (unicode.IsSpace(c) && c != '\u0085') }) == "" {
		return false
	}
	for _, c := range v {
		if c < 32 || c == 127 {
			return false
		}
	}
	return true
}

// Alias dereference is bounded; a cyclic or excessively indirect node remains invalid.
func validationNode(n *yaml.Node) *yaml.Node {
	for i := 0; i < 32 && n != nil && n.Kind == yaml.AliasNode; i++ {
		n = n.Alias
	}
	if n == nil {
		return &yaml.Node{}
	}
	return n
}

func (checks *ValidationChecks) UnmarshalYAML(n *yaml.Node) error {
	n = validationNode(n)
	if n.Kind != yaml.SequenceNode || len(n.Content) > 32 {
		return errors.New("validate must be a list of at most 32 named checks")
	}
	names := map[string]bool{}
	out := make(ValidationChecks, 0, len(n.Content))
	for _, item := range n.Content {
		item = validationNode(item)
		if item.Kind != yaml.MappingNode {
			return errors.New("validate checks must be name/run mappings")
		}
		values := map[string]string{}
		for i := 0; i < len(item.Content); i += 2 {
			key, value := validationNode(item.Content[i]), validationNode(item.Content[i+1])
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" || (key.Value != "name" && key.Value != "run") || value.Kind != yaml.ScalarNode || value.Tag != "!!str" {
				return errors.New("validate check needs only string name/run fields")
			}
			if _, ok := values[key.Value]; ok {
				return errors.New("validate check has duplicate fields")
			}
			values[key.Value] = value.Value
		}
		name, run := values["name"], values["run"]
		if !validValidationName(name) || names[name] || len(run) == 0 || len(run) > 8192 || strings.ContainsRune(run, 0) || strings.Trim(run, " \t\r\n") == "" {
			return errors.New("validate check has invalid/duplicate name or blank/unbounded run")
		}
		names[name] = true
		out = append(out, ValidationCheck{Name: name, Run: run})
	}
	*checks = out
	return nil
}
