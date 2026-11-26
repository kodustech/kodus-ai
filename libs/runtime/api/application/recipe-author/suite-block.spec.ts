import { DEFAULT_SUITE_RESULTS_GLOB, parseRecipe, type Recipe } from '@libs/runtime/protocol/recipe';

import { ciEvidence } from './ci-evidence';
import type { RepoReader } from './repo-reader';
import { appendSuiteBlock, suiteBlockOf } from './suite-block';

function reader(files: Record<string, string>): RepoReader {
    return {
        list: async (dir) => {
            const prefix = dir ? `${dir}/` : '';
            const out = new Set<string>();
            for (const f of Object.keys(files)) {
                if (!f.startsWith(prefix)) continue;
                const rest = f.slice(prefix.length);
                out.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
            }
            return [...out].sort();
        },
        read: async (path) => files[path] ?? null,
    };
}

const CYPRESS_MATRIX = `
jobs:
  cypress:
    strategy:
      matrix:
        containers: [1, 2, 3]
    env:
      CYPRESS_RECORD_KEY: \${{ secrets.CYPRESS_RECORD_KEY }}
    steps:
      - run: npx cypress run --browser chrome --record --parallel --key \${{ secrets.CYPRESS_RECORD_KEY }} --group ci
`;
const CONFIG = "export default { e2e: { specPattern: 'cypress/e2e/**/*.cy.ts' } };";
const BASE = 'version: 1\nservices:\n  compose:\n    files: [docker-compose.yml]\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n';

const evidence = (files: Record<string, string>) => ciEvidence(reader(files));
const suiteOf = (text: string): NonNullable<Recipe['suite']> => {
    const parsed = parseRecipe(text);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed.recipe.suite!;
};

describe('the suite block the author writes from CI (e2e-suites.md section 3)', () => {
    it('turns a cypress job with a 3-way matrix and --record --parallel into a block with {specs} and no Cloud flags, and no `shards` (a CI matrix entry is not a Runtime host)', async () => {
        const ev = await evidence({ '.github/workflows/e2e.yml': CYPRESS_MATRIX, 'cypress.config.ts': CONFIG });
        const out = appendSuiteBlock(BASE, ev);
        expect(out.suiteKeys).toEqual(expect.arrayContaining(['runner', 'command', 'specs', 'results']));
        expect(out.suiteKeys).not.toContain('shards');
        const suite = suiteOf(out.recipe);
        expect(suite).toMatchObject({ runner: 'cypress', specs: 'cypress/e2e/**/*.cy.ts' });
        expect(suite.shards).toBeUndefined();
        expect(suite.command).toContain('{specs}');
        expect(suite.command).not.toMatch(/--record|--parallel|--key|--group/);
        expect(suite.results?.junit).toBe(DEFAULT_SUITE_RESULTS_GLOB);
        expect(out.recipe).not.toContain('CYPRESS_RECORD_KEY');
    });

    it('marks the block as inferred in a comment naming its source and the inferred keys', async () => {
        const ev = await evidence({ '.github/workflows/e2e.yml': CYPRESS_MATRIX, 'cypress.config.ts': CONFIG });
        expect(appendSuiteBlock(BASE, ev).recipe).toMatch(/# suite: origin inferred from e2e\.yml job cypress; keys: runner, command/);
    });

    it('makes the command write JUnit into the results glob it names', async () => {
        const ev = await evidence({ '.github/workflows/e2e.yml': CYPRESS_MATRIX, 'cypress.config.ts': CONFIG });
        const suite = suiteOf(appendSuiteBlock(BASE, ev).recipe);
        expect(suite.command).toContain('--reporter junit');
        expect(suite.command).toContain('mochaFile=results/');
    });

    it('writes no block for a workflow with no e2e job', async () => {
        const ev = await evidence({ '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: pnpm test\n' });
        expect(appendSuiteBlock(BASE, ev)).toEqual({ recipe: BASE, suiteKeys: [] });
    });

    it('writes no block when two jobs run different suites', async () => {
        const wf = 'jobs:\n  a:\n    steps:\n      - run: npx cypress run\n  b:\n    steps:\n      - run: npx playwright test\n';
        const ev = await evidence({ '.github/workflows/e2e.yml': wf, 'cypress.config.ts': CONFIG });
        expect(appendSuiteBlock(BASE, ev).suiteKeys).toEqual([]);
    });

    it('writes no block when no config states the spec glob (no guess)', async () => {
        const ev = await evidence({ '.github/workflows/e2e.yml': CYPRESS_MATRIX });
        expect(suiteBlockOf(ev)).toBeUndefined();
    });

    it('never overrides a suite the recipe already has', async () => {
        const ev = await evidence({ '.github/workflows/e2e.yml': CYPRESS_MATRIX, 'cypress.config.ts': CONFIG });
        const has = `${BASE}suite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: x/**\n`;
        expect(appendSuiteBlock(has, ev)).toEqual({ recipe: has, suiteKeys: [] });
    });

    it('writes no shards even for a wide matrix and keeps a playwright command with its own reporter', async () => {
        const wf = `jobs:\n  pw:\n    strategy:\n      matrix:\n        shard: [${Array.from({ length: 18 }, (_, i) => i + 1).join(',')}]\n    steps:\n      - run: npx playwright test --reporter=list\n`;
        const ev = await evidence({ '.github/workflows/pw.yml': wf, 'playwright.config.ts': "export default { testDir: './e2e' };" });
        const suite = suiteOf(appendSuiteBlock(BASE, ev).recipe);
        expect(suite.shards).toBeUndefined();
        expect(suite.command).toBe('npx playwright test --reporter=list {specs}');
    });
});
