import { CI_EVIDENCE_MAX_CHARS, ciEvidenceBlock } from './ci-evidence';
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
