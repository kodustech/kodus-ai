import { suiteConfigOf } from '../../../../apps/runtime/src/worker/suite/suite-config';
import { suiteOfRecipeAt } from '../application/suite-recipe';
import { parseRecipe, SUITE_LIMITS } from '@libs/runtime/protocol/recipe';

const SHA = 'a'.repeat(40);
const REPO = {
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'acme/shop',
};
const RECIPE =
    'version: 1\nservices:\n  compose:\n    public: app\nsuite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: "cypress/e2e/**/*.cy.ts"\n  shards: 3\n';

const noCommittedRecipe = { readFileAtCommit: async () => null };
const committedRecipe = { readFileAtCommit: async () => RECIPE };
const setupOf = (origin: 'authored' | 'inferred' | 'repository' | undefined) =>
    ({
        sha: SHA,
        recipe: {
            path: '.kodus/workspace.yaml',
            sha: SHA,
            state: 'found' as const,
            content: RECIPE,
            ...(origin ? { origin } : {}),
        },
    }) as never;

describe('the shard ceiling of a suite (the customer commits it, an environment recipe never sets it)', () => {
    it('is the recipe shards when the customer committed the recipe in the repository', async () => {
        const suite = await suiteOfRecipeAt(committedRecipe, REPO, SHA);
        expect(suite).toMatchObject({ source: 'repository', shards: 3 });
    });

    it.each(['authored', 'inferred'] as const)(
        'is the limit of the suite when the recipe is the one the environment booted (%s), whatever shards it says',
        async (origin) => {
            const suite = await suiteOfRecipeAt(
                noCommittedRecipe,
                REPO,
                SHA,
                setupOf(origin),
            );
            expect(suite).toMatchObject({
                source: 'environment',
                shards: SUITE_LIMITS.shards,
            });
        },
    );

    it.each([
        ['a committed recipe', committedRecipe, undefined, 'repository'],
        ['an authored recipe', noCommittedRecipe, 'authored', 'environment'],
        ['an inferred recipe', noCommittedRecipe, 'inferred', 'environment'],
    ] as const)(
        'is the same number of download tokens and engine hosts for %s',
        async (_name, git, origin, source) => {
            const product = await suiteOfRecipeAt(
                git,
                REPO,
                SHA,
                origin ? setupOf(origin) : undefined,
            );
            const parsed = parseRecipe(RECIPE);
            if (parsed.ok === false) throw new Error(parsed.error);
            const worker = suiteConfigOf(parsed.recipe, { origin })!;
            expect(product?.source).toBe(source);
            expect(worker.config.maxShards).toBe(product!.shards);
        },
    );
});
