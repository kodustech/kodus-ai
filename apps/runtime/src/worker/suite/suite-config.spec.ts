import { parseRecipe } from '@libs/runtime/protocol/recipe';

import { suiteConfigOf } from './suite-config';

const recipeWith = (suite: string) => {
    const parsed = parseRecipe(`version: 1\nservices:\n  compose:\n    public: app\n${suite}`);
    if (parsed.ok === false) throw new Error(parsed.error);
    return parsed.recipe;
};

describe('the suite block of a recipe as the engine reads it', () => {
    it('is absent when the recipe declares no suite', () => {
        expect(suiteConfigOf(recipeWith(''))).toBeUndefined();
    });

    it('fills the defaults: the results glob of the runner, a 25 minute shard, the ceiling of the limits', () => {
        const c = suiteConfigOf(recipeWith('suite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: "cypress/e2e/**/*.cy.ts"\n'))!;
        expect(c.config).toMatchObject({ runner: 'cypress', command: 'npx cypress run --spec "{specs}"', env: {}, shardTimeoutMs: 25 * 60_000, maxShards: 16, gate: 'default' });
        expect(c.config.resultsGlob).toBe('results/*.xml');
        expect(c.specsGlob).toBe('cypress/e2e/**/*.cy.ts');
        expect(c.baseline).toBe(true);
    });

    it('takes what the recipe sets: directory, results, shard timeout, shard ceiling, gate, env, no baseline', () => {
        const c = suiteConfigOf(
            recipeWith(
                'suite:\n  runner: playwright\n  command: npx playwright test {specs}\n  cwd: apps/dashboard\n  specs: "e2e/**/*.spec.ts"\n  shards: 3\n  timeout: { shard: 10m }\n  env: { BASE_URL: "http://web:3000" }\n  results: { junit: "out/*.xml" }\n  baseline: false\n  gate: strict\n  ignore: ["docs/**"]\n',
            ),
        )!;
        expect(c.config).toMatchObject({ runner: 'playwright', cwd: 'apps/dashboard', resultsGlob: 'out/*.xml', shardTimeoutMs: 10 * 60_000, maxShards: 3, gate: 'strict', env: { BASE_URL: 'http://web:3000' } });
        expect(c.baseline).toBe(false);
        expect(c.ignore).toEqual(['docs/**']);
    });

    it('takes the compose service the suite runs in, and none when the recipe names none', () => {
        const base = 'suite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: "cypress/e2e/**/*.cy.ts"\n';
        expect(suiteConfigOf(recipeWith(`${base}  service: e2e\n`))!.config.service).toBe('e2e');
        expect(suiteConfigOf(recipeWith(base))!.config).not.toHaveProperty('service');
    });
});
