import { type BlockerRule, evidenceOf, fixRecipe, retry } from './rule';

// Rules that read the kind the cell or the worker declared, before any log:
// what they name is already the cause.

const PLATFORM_STEPS: Record<string, string> = {
    org_key: 'getting the organization key',
    claim_keys: 'issuing the machine keys',
    claim_network: 'creating the machine network',
    create_workload: 'creating the machine',
    create_observer: 'creating the observer machine',
    repo_source: 'reaching the repository',
    repo_fetch: 'downloading the repository',
    repo_upload: 'copying the repository to the machine',
    workdir: 'preparing the work directory',
    egress_policy: 'applying the outbound policy',
    cell_lost: 'keeping the cell connected during the boot',
};

/** Kodus's own steps: nothing in the repository to change. */
export const platformStepRule: BlockerRule = {
    id: 'platform_step',
    classify: ({ input }) => {
        const step = PLATFORM_STEPS[input.signature];
        if (!step || (input.kind !== 'platform' && input.kind !== 'resources')) return null;
        return {
            kind: input.kind,
            signature: input.signature,
            title: `Kodus failed while ${step}`,
            evidence: evidenceOf({ text: input.message }),
            fixes: [retry],
        };
    },
};

export const securityViolationRule: BlockerRule = {
    id: 'security_violation',
    classify: ({ input }) =>
        input.kind === 'security_violation'
            ? {
                  kind: 'security_violation',
                  signature: input.signature,
                  title: 'The run was stopped: code tried to send a credential out',
                  evidence: evidenceOf({ text: input.message }),
                  fixes: [],
              }
            : null,
};

export const recipeOutdatedRule: BlockerRule = {
    id: 'recipe_outdated',
    classify: ({ input }) =>
        input.kind === 'recipe_outdated'
            ? {
                  kind: 'recipe_outdated',
                  signature: input.signature,
                  title: "The recipe doesn't load",
                  evidence: evidenceOf({ text: input.message }),
                  fixes: [fixRecipe('Open .kodus/workspace.yaml on the default branch and fix the error shown here; the next setup reads it again.')],
              }
            : null,
};

/**
 * services.needs: the cell refuses a recipe that boots other repositories beside this one
 * (what would run without them is not the app), before its project comes up.
 */
export const recipeNeedsRule: BlockerRule = {
    id: 'recipe_needs',
    classify: ({ input }) =>
        input.kind === 'other_repo' && input.signature === 'recipe_needs'
            ? {
                  kind: 'other_repo',
                  signature: input.signature,
                  title: 'The recipe needs other repositories, which a cell does not boot yet',
                  evidence: evidenceOf({ text: input.message }),
                  fixes: [
                      fixRecipe(
                          'Remove services.needs from .kodus/workspace.yaml on the default branch, and give the services it named a stand-in in the compose file (a fake under the same service name); the next setup boots without them.',
                      ),
                  ],
              }
            : null,
};

/** No recipe, no compose file, no Dockerfile: Kodus could not infer a recipe (setup step `recipe`). */
export const noRecipeRule: BlockerRule = {
    id: 'no_recipe',
    classify: ({ input }) =>
        input.kind === 'no_recipe'
            ? {
                  kind: 'recipe_outdated',
                  signature: input.signature,
                  title: 'Kodus found nothing to boot this repository from',
                  evidence: evidenceOf({ text: input.message }),
                  fixes: [
                      fixRecipe(
                          'Add a compose file or a Dockerfile at the repository root, and the next setup infers a recipe from it. Or write .kodus/workspace.yaml yourself (docs §6).',
                      ),
                  ],
              }
            : null,
};
