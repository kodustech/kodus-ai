import { parseRecipe } from '@libs/runtime/protocol/recipe';

import { CI_EVIDENCE_MAX_CHARS, ciEvidence, ciEvidenceBlock } from './ci-evidence';
import type { RepoReader } from './repo-reader';

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

const E2E = `
name: E2E
on: { pull_request: {} }
jobs:
  e2e:
    name: Storefront e2e
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: postgres://user:hunter2@localhost:5432/shop
      STRIPE_SECRET_KEY: \${{ secrets.STRIPE_SECRET_KEY }}
    services:
      db:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: s3cr3t-value
        ports: ['5432:5432']
      redis:
        image: redis:7
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter storefront build
      - run: |
          pnpm --filter storefront db:seed
          docker compose -f apps/storefront/compose.yml up -d
        env:
          SEED_ADMIN_PASSWORD: another-secret
      - run: pnpm playwright test
`;
const LINT = `
name: Lint
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm lint
`;

describe('CI evidence for the recipe author', () => {
    it('summarises the job that boots the app for tests: services, setup, build and start commands, env names', async () => {
        const block = await ciEvidenceBlock(reader({ '.github/workflows/e2e.yml': E2E }));
        expect(block).toContain('e2e.yml');
        expect(block).toContain('Storefront e2e');
        expect(block).toContain('postgres:16');
        expect(block).toContain('redis:7');
        expect(block).toContain('setup-node');
        expect(block).toContain('pnpm --filter storefront build');
        expect(block).toContain('pnpm --filter storefront db:seed');
        expect(block).toContain('docker compose -f apps/storefront/compose.yml up -d');
        expect(block).toContain('pnpm playwright test');
        expect(block).toContain('DATABASE_URL');
        expect(block).toContain('STRIPE_SECRET_KEY');
        expect(block).toContain('SEED_ADMIN_PASSWORD');
    });

    it('leaves out a workflow that only lints', async () => {
        const block = await ciEvidenceBlock(reader({ '.github/workflows/lint.yml': LINT }));
        expect(block).toBe('');
    });

    it('never carries an environment value or a secret', async () => {
        const block = await ciEvidenceBlock(reader({ '.github/workflows/e2e.yml': E2E }));
        for (const leaked of ['hunter2', 's3cr3t-value', 'another-secret', 'secrets.STRIPE']) expect(block).not.toContain(leaked);
    });

    it('masks a secret typed inline in a command', async () => {
        const wf = `
jobs:
  e2e:
    steps:
      - run: API_TOKEN=abc123xyz pnpm cypress run
`;
        const block = await ciEvidenceBlock(reader({ '.github/workflows/e2e.yml': wf }));
        expect(block).toContain('pnpm cypress run');
        expect(block).not.toContain('abc123xyz');
    });

    it('is empty when the repository has no workflows or one that is not YAML', async () => {
        expect(await ciEvidenceBlock(reader({ 'README.md': '' }))).toBe('');
        expect(await ciEvidenceBlock(reader({ '.github/workflows/e2e.yml': ': : [' }))).toBe('');
    });

    it('stays within the cap however many jobs the repository has', async () => {
        const jobs = Array.from({ length: 60 }, (_, i) => `  e2e${i}:\n    steps:\n      - run: pnpm playwright test --project=${'long'.repeat(30)}${i}`).join('\n');
        const block = await ciEvidenceBlock(reader({ '.github/workflows/e2e.yml': `jobs:\n${jobs}\n` }));
        expect(block.length).toBeGreaterThan(0);
        expect(block.length).toBeLessThanOrEqual(CI_EVIDENCE_MAX_CHARS);
    });
});

// docs/runtime/e2e-suites.md section 3: the structured candidate for the recipe's suite block.
const CYPRESS_MATRIX = `
name: E2E
jobs:
  cypress:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        containers: [1, 2, 3]
    env:
      CYPRESS_RECORD_KEY: \${{ secrets.CYPRESS_RECORD_KEY }}
      BASE_URL: http://localhost:3000
      STRIPE_API_KEY: sk-live-abcdefghijklmnop12345
      DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm --filter dashboard build
      - name: Cypress
        working-directory: apps/dashboard
        run: npx cypress run --browser chrome --record --parallel --key \${{ secrets.CYPRESS_RECORD_KEY }} --group "ci" --spec "cypress/e2e/**/*.cy.ts"
`;
const CYPRESS_CONFIG = `import { defineConfig } from 'cypress';
export default defineConfig({ component: { specPattern: 'src/**/*.cy.tsx' }, e2e: { baseUrl: 'http://localhost:3000', specPattern: 'cypress/e2e/**/*.cy.ts' } });`;

describe('ciEvidence suiteCandidate', () => {
    const files = { '.github/workflows/e2e.yml': CYPRESS_MATRIX, 'apps/dashboard/cypress.config.ts': CYPRESS_CONFIG };

    it('reads the runner, the matrix size, the directory and the spec glob from a cypress job', async () => {
        const { suiteCandidate } = await ciEvidence(reader(files));
        expect(suiteCandidate).toMatchObject({ runner: 'cypress', matrixSize: 3, cwd: 'apps/dashboard', specs: 'cypress/e2e/**/*.cy.ts', origin: 'inferred' });
    });

    // A design partner's cypress.config.ts lists its globs: no suite block was ever written for it.
    it('reads a specPattern given as an array: the glob that covers the others, else them all as alternatives', async () => {
        const config = (list: string) => `import { defineConfig } from 'cypress';\nexport default defineConfig({ e2e: { baseUrl: 'http://localhost:3000', specPattern: [${list}], supportFile: 'cypress/support/e2e.ts' } });`;
        const covered = await ciEvidence(reader({ ...files, 'apps/dashboard/cypress.config.ts': config(`'cypress/e2e/*.spec.cy.ts', 'cypress/e2e/**/*.spec.cy.ts'`) }));
        expect(covered.suiteCandidate!.specs).toBe('cypress/e2e/**/*.spec.cy.ts');
        const both = await ciEvidence(reader({ ...files, 'apps/dashboard/cypress.config.ts': config(`"cypress/e2e/**/*.cy.ts",\n  "cypress/smoke/**/*.cy.ts"`) }));
        expect(both.suiteCandidate!.specs).toBe('{cypress/e2e/**/*.cy.ts,cypress/smoke/**/*.cy.ts}');
        const unsafe = await ciEvidence(reader({ ...files, 'apps/dashboard/cypress.config.ts': config(`'../outside/**/*.cy.ts'`) }));
        expect(unsafe.suiteCandidate!.specs).toBeUndefined();
    });

    it('strips the Cypress Cloud flags and keeps the rest of the command, with the spec list as {specs}', async () => {
        const { suiteCandidate } = await ciEvidence(reader(files));
        expect(suiteCandidate!.command).toBe('npx cypress run --browser chrome --spec "{specs}"');
        expect(suiteCandidate!.strippedFlags).toEqual(expect.arrayContaining(['--record', '--parallel', '--key', '--group', 'CYPRESS_RECORD_KEY']));
    });

    it('carries env and secret names only, never a value, and never the Cloud record key', async () => {
        const { suiteCandidate, block } = await ciEvidence(reader(files));
        expect(suiteCandidate!.envNames).toEqual(expect.arrayContaining(['BASE_URL', 'STRIPE_API_KEY', 'DEPLOY_TOKEN']));
        expect(suiteCandidate!.envNames).not.toContain('CYPRESS_RECORD_KEY');
        expect(suiteCandidate!.secretNames.sort()).toEqual(['DEPLOY_TOKEN', 'STRIPE_API_KEY']);
        for (const leaked of ['sk-live-abcdefghijklmnop12345', 'secrets.', 'localhost:3000']) {
            expect(JSON.stringify(suiteCandidate)).not.toContain(leaked);
            expect(block).not.toContain('sk-live-abcdefghijklmnop12345');
        }
    });

    it('gives a command the recipe schema accepts as a suite block', async () => {
        const { suiteCandidate: c } = await ciEvidence(reader(files));
        const text = `version: 1\nsuite:\n  runner: ${c!.runner}\n  command: ${JSON.stringify(c!.command)}\n  cwd: ${c!.cwd}\n  specs: ${JSON.stringify(c!.specs)}\n  shards: ${c!.matrixSize}\n`;
        expect(parseRecipe(text)).toMatchObject({ ok: true });
    });

    it('falls back to the runner default glob, not a guess, when no config states one', async () => {
        const { suiteCandidate } = await ciEvidence(reader({ '.github/workflows/e2e.yml': CYPRESS_MATRIX }));
        expect(suiteCandidate!.specs).toBeUndefined();
    });

    it('reads a playwright job, drops --shard and takes testDir from its config', async () => {
        const wf = `
jobs:
  pw:
    strategy:
      matrix:
        shard: [1, 2]
    steps:
      - run: npx playwright test --shard=\${{ matrix.shard }}/2 --project=chromium
`;
        const { suiteCandidate } = await ciEvidence(
            reader({ '.github/workflows/pw.yml': wf, 'playwright.config.ts': "export default { testDir: './e2e', retries: 2 };" }),
        );
        expect(suiteCandidate).toMatchObject({ runner: 'playwright', command: 'npx playwright test --project=chromium {specs}', matrixSize: 2, specs: 'e2e/**/*.{spec,test}.{js,ts,mjs,cjs}' });
    });

    it('reads the cypress GitHub action, with its record and parallel inputs stripped', async () => {
        const wf = `
jobs:
  e2e:
    steps:
      - uses: cypress-io/github-action@v6
        with:
          command: npx cypress run --browser chrome
          record: true
          parallel: true
`;
        const { suiteCandidate } = await ciEvidence(reader({ '.github/workflows/e2e.yml': wf }));
        expect(suiteCandidate).toMatchObject({ runner: 'cypress', command: 'npx cypress run --browser chrome --spec "{specs}"' });
        expect(suiteCandidate!.strippedFlags).toEqual(expect.arrayContaining(['record', 'parallel']));
    });

    it('drops an inline variable from the command and names it', async () => {
        const wf = 'jobs:\n  e2e:\n    steps:\n      - run: API_TOKEN=abc123xyz pnpm cypress run\n';
        const { suiteCandidate } = await ciEvidence(reader({ '.github/workflows/e2e.yml': wf }));
        expect(suiteCandidate!.command).toBe('pnpm cypress run --spec "{specs}"');
        expect(suiteCandidate!.envNames).toContain('API_TOKEN');
        expect(JSON.stringify(suiteCandidate)).not.toContain('abc123xyz');
    });

    it('is absent when no job runs cypress or playwright directly (no guess)', async () => {
        const wf = 'jobs:\n  integration:\n    steps:\n      - run: pnpm test:e2e\n';
        const { suiteCandidate, block } = await ciEvidence(reader({ '.github/workflows/e2e.yml': wf }));
        expect(suiteCandidate).toBeUndefined();
        expect(block).toContain('pnpm test:e2e');
    });

    it('is absent for a repository with no workflow, and ciEvidenceBlock is still the same text', async () => {
        expect(await ciEvidence(reader({ 'README.md': '' }))).toEqual({ block: '' });
        const r = reader(files);
        expect(await ciEvidenceBlock(r)).toBe((await ciEvidence(r)).block);
    });

    it('flags two jobs that run different suites as ambiguous, and one suite in two jobs as not', async () => {
        const two = 'jobs:\n  a:\n    steps:\n      - run: npx cypress run --spec "cypress/e2e/**/*.cy.ts"\n  b:\n    steps:\n      - run: npx playwright test\n';
        expect((await ciEvidence(reader({ '.github/workflows/e2e.yml': two }))).suiteAmbiguous).toBe(true);
        const same = 'jobs:\n  a:\n    steps:\n      - run: npx cypress run --browser chrome\n  b:\n    steps:\n      - run: npx cypress run --browser chrome --record\n';
        expect((await ciEvidence(reader({ '.github/workflows/e2e.yml': same }))).suiteAmbiguous).toBeUndefined();
    });
});
