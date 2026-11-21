package recipe

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// services.needs: the other repositories a recipe boots beside its own,
// each in its own directory next to it. The rules are the worker's
// (libs/runtime/protocol/recipe.ts resolveNeeds, and the alias rule of
// libs/runtime/contracts/workspace.ts), held to the same verdicts by the
// recipe contract.

// MaxNeeds bounds services.needs (MAX_RECIPE_NEEDS).
const MaxNeeds = protocol.MaxRecipeNeeds

const needsShape = "services.needs must be a list of repositories (- repo: owner/name, alias: name)"

var (
	// AliasPattern is a repository's directory in the workspace.
	AliasPattern = regexp.MustCompile(protocol.RepositoryAliasPattern)
	// fullNamePattern is owner/name, or group/subgroup/name.
	fullNamePattern = regexp.MustCompile(protocol.RepositoryFullNamePattern)
	aliasRun        = regexp.MustCompile(`[^a-z0-9._-]+`)
	aliasLead       = regexp.MustCompile(`^[^a-z0-9]+`)
)

const maxFullName = protocol.MaxRepositoryFullName

// Need is one other repository booted beside the recipe's own: Repo is
// owner/name, Alias its directory beside this one.
type Need struct {
	Repo  string `json:"repo"`
	Alias string `json:"alias"`
}

// DeclaredNeeds is services.needs as written; Parse resolves it into
// Services.Needs.
type DeclaredNeeds []DeclaredNeed

// DeclaredNeed is one entry as written: Alias is nil when the recipe gives
// none.
type DeclaredNeed struct {
	Repo  string
	Alias *string
}

func (d *DeclaredNeeds) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind != yaml.SequenceNode {
		return errors.New(needsShape)
	}
	if len(n.Content) > MaxNeeds {
		return fmt.Errorf("services.needs: at most %d repositories", MaxNeeds)
	}
	out := make(DeclaredNeeds, 0, len(n.Content))
	for i, item := range n.Content {
		if item.Kind != yaml.MappingNode {
			return fmt.Errorf("services.needs[%d]: a repository is a mapping (repo, alias)", i)
		}
		var need DeclaredNeed
		hasRepo := false
		for j := 0; j+1 < len(item.Content); j += 2 {
			k, v := item.Content[j].Value, item.Content[j+1]
			if k != "repo" && k != "alias" {
				return fmt.Errorf("services.needs[%d]: unknown field %q", i, k)
			}
			if v.Kind != yaml.ScalarNode || v.ShortTag() != "!!str" {
				return fmt.Errorf("services.needs[%d].%s: expected string", i, k)
			}
			if k == "repo" {
				need.Repo, hasRepo = v.Value, true
			} else {
				alias := v.Value
				need.Alias = &alias
			}
		}
		if !hasRepo {
			return fmt.Errorf("services.needs[%d].repo: expected string", i)
		}
		out = append(out, need)
	}
	*d = out
	return nil
}

// AliasOf is the alias a repository gets when none is given: its short name
// (after the last /) in lower case, every run of other characters as one
// "-", without a leading ".", "_" or "-", cut to 63 characters; "repo"
// when nothing is left (repositoryAliasOf, and the membership backfill).
func AliasOf(name string) string {
	alias := strings.ToLower(name[strings.LastIndex(name, "/")+1:])
	alias = aliasLead.ReplaceAllString(aliasRun.ReplaceAllString(alias, "-"), "")
	if len(alias) > 63 {
		alias = alias[:63]
	}
	if !AliasPattern.MatchString(alias) {
		return FallbackAlias
	}
	return alias
}

// FallbackAlias is the alias of a repository whose name leaves none.
const FallbackAlias = protocol.FallbackRepositoryAlias

// resolveNeeds sets every alias and refuses a repository that is not
// owner/name, and a repository or an alias twice.
func resolveNeeds(declared DeclaredNeeds) ([]Need, error) {
	repos := map[string]bool{}
	aliases := map[string]bool{}
	var out []Need
	for i, n := range declared {
		at := fmt.Sprintf("services.needs[%d]", i)
		if len(n.Repo) > maxFullName || !fullNamePattern.MatchString(n.Repo) {
			return nil, fmt.Errorf("%s.repo: %s must be owner/name", at, strconv.Quote(n.Repo))
		}
		if n.Alias != nil && !AliasPattern.MatchString(*n.Alias) {
			return nil, fmt.Errorf("%s.alias: %s must match %s", at, strconv.Quote(*n.Alias), AliasPattern)
		}
		alias := AliasOf(n.Repo)
		if n.Alias != nil {
			alias = *n.Alias
		}
		repo := strings.ToLower(n.Repo)
		if repos[repo] {
			return nil, fmt.Errorf("%s: %s twice", at, n.Repo)
		}
		if aliases[alias] {
			return nil, fmt.Errorf("%s: alias %s twice", at, alias)
		}
		repos[repo], aliases[alias] = true, true
		out = append(out, Need{Repo: n.Repo, Alias: alias})
	}
	return out, nil
}

// NeedsConflict says why services.needs cannot boot beside the environment's
// own repository (primaryRepo, owner/name, in its directory primaryAlias):
// a need never names that repository, nor takes its alias
// (recipeNeedsConflict). Nil when none does.
func (r *Recipe) NeedsConflict(primaryRepo, primaryAlias string) error {
	for i, n := range r.Services.Needs {
		if strings.EqualFold(n.Repo, primaryRepo) {
			return fmt.Errorf("services.needs[%d]: %s is the environment's own repository", i, n.Repo)
		}
		if n.Alias == primaryAlias {
			return fmt.Errorf("services.needs[%d]: alias %s is the environment's own repository's", i, n.Alias)
		}
	}
	return nil
}
