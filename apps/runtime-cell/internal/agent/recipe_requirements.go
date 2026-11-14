package agent

import (
	"errors"
	"slices"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// RecipeEgressValidator checks requirements, never grants them. The composition
// root supplies its defaults and the claim supplies its current admin approvals.
type RecipeEgressValidator interface {
	CheckRecipeEgress(rec *recipe.Recipe, approved []string) error
}

type RecipeEgressRefused struct {
	Signature string
	Hosts     []string
}

func (e *RecipeEgressRefused) Error() string {
	if e.Signature == "recipe_egress_denied" {
		return "the recipe requires outbound hosts denied by cell policy"
	}
	return "the recipe requires outbound hosts that need administrator approval"
}

// CheckRecipeEgress preserves the existing authority: declarations do not enter
// the allowlist. Platform denials win even over defaults and admin approvals.
func CheckRecipeEgress(rec *recipe.Recipe, defaults, approved []string, denied func(string) bool) error {
	if rec == nil {
		return nil
	}
	allowed, err := policy.MergeAllow(defaults, approved)
	if err != nil {
		return err
	}
	var missing, blocked []string
	platform := netguard.DenyList{}
	for _, host := range rec.EgressRequirements() {
		if platform.Denies(host) || (denied != nil && denied(host)) {
			blocked = append(blocked, host)
		} else if !slices.Contains(allowed, host) {
			missing = append(missing, host)
		}
	}
	if len(blocked) > 0 {
		return &RecipeEgressRefused{Signature: "recipe_egress_denied", Hosts: blocked}
	}
	if len(missing) > 0 {
		return &RecipeEgressRefused{Signature: "recipe_egress_approval_required", Hosts: missing}
	}
	return nil
}

// checkRecipeRequirements runs after the trusted base recipe is overlaid and
// before Upload: a transport may build while uploading the checkout.
func (a *Agent) checkRecipeRequirements(c *claims.Claim, repo string) error {
	rec, err := recipe.Load(repo)
	if err != nil {
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_load", err)
	}
	if rec == nil {
		return nil
	}
	if err := rec.RequirePinnedFakes(); err != nil {
		return blockerErr(protocol.BlockerKindRecipeOutdated, "fake_image_pin_required", err)
	}
	if len(rec.FakeServices()) > 0 {
		if !a.cfg.FakeSupport {
			return blockerErr(protocol.BlockerKindPlatform, "recipe_fakes_unsupported", errors.New("this driver does not execute declared fake services"))
		}
		if _, err := loadClaimCompose(c, repo, rec); err != nil {
			return err
		}
	}
	if requiresObserverSQL(rec) && a.cfg.SQLObservers == nil {
		return blockerErr(protocol.BlockerKindPlatform, "sql_observer_unsupported", errors.New("this driver cannot provision a seeded SQL observer account; use HTTP probes or a supported cell"))
	}
	if size := rec.SizeRequirement(); size != nil {
		if size.DiskGB > 0 {
			return blockerErr(protocol.BlockerKindResources, "recipe_disk_unsupported", errors.New("the recipe requires disk enforcement, which this Runtime path does not support"))
		}
		if size.CPUs > 0 && c.Acquire.Size == nil {
			return blockerErr(protocol.BlockerKindResources, "recipe_size_unreserved", errors.New("the recipe size was not reserved by the product; request a new setup with an updated product"))
		}
	}
	if len(rec.EgressRequirements()) == 0 {
		return nil
	}
	if c.Acquire.Recipe == nil {
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_source_unavailable", errors.New("egress requirements need the trusted base recipe"))
	}
	if a.cfg.RecipeEgress == nil {
		return blockerErr(protocol.BlockerKindExternalService, "recipe_egress_approval_required", errors.New("this cell cannot authorize the recipe egress requirements"))
	}
	approved, _, _ := c.PendingAllow()
	if err := a.cfg.RecipeEgress.CheckRecipeEgress(rec, approved); err != nil {
		var refused *RecipeEgressRefused
		if errors.As(err, &refused) {
			return blockerErr(protocol.BlockerKindExternalService, refused.Signature, refused)
		}
		return blockerErr(protocol.BlockerKindPlatform, "recipe_egress_policy", errors.New("the cell could not validate recipe egress requirements"))
	}
	return nil
}
