import { RuntimeRunRequestedSchema } from '@libs/runtime/run/run-messages';

import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import { RuntimeSuiteInputs } from '../application/suite-inputs.service';
import type { PullRequestHead, RuntimeGitPort } from '../domain/ports';
import { BASE_SHA, ORG, REPO, SHA, TEAM, clock, config, openSealed } from './fixtures';

jest.mock('@libs/core/log/logger', () => ({ createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

// docs/runtime/e2e-suites.md sections 10.2 and 11: Run mode. A Run whose environment recipe declares a `suite:` block carries the
// suite section: the template's main commit, the PR's files and one sealed download token per claim, bound to the Run.

const RUN = '11111111-1111-4111-8111-111111111111';
const MAIN = 'd'.repeat(40);
const SUITE = 'suite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: "cypress/e2e/**/*.cy.ts"\n  shards: 2\n';
const recipe = `version: 1\nservices:\n  compose:\n    public: app\n${SUITE}`;
const env = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' };
const head: PullRequestHead = { headSha: SHA, baseSha: BASE_SHA, fork: false };

function world(o: { recipe?: string | null; setupSha?: string | null; removed?: string[]; truncated?: boolean; compare?: unknown } = {}) {
    const issued: string[] = [];
    const git = { getPullRequestDiff: async () => ({ files: [{ path: 'src/a.ts', patch: '' }, { path: 'src/new.ts', previousPath: 'src/old.ts', patch: '' }], truncated: !!o.truncated, ...(o.removed ? { removedFiles: o.removed } : {}) }), readFileAtCommit: async () => (o.recipe === undefined ? recipe : o.recipe), ...(o.compare === undefined ? {} : { compareWithMain: async () => (o.compare === 'throws' ? Promise.reject(new Error('git api down')) : o.compare) }) } as unknown as RuntimeGitPort;
    const tokens = { issue: async () => (issued.push('t'), `ghs_${issued.length}`) };
    const setups = { get: async () => (o.setupSha === null ? null : { sha: o.setupSha ?? MAIN }) };
    const inputs = new RuntimeSuiteInputs(git, tokens, config(), setups as any);
    const builder = new RuntimeRunRequestBuilder(git, tokens, { get: async () => ({ ...env, imageId: 'image-1', expose: [] }) }, config(), clock, undefined, undefined, undefined, undefined, inputs);
    return { builder, issued };
}
const build = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => w.builder.build({ env, prNumber: 7, head, trigger: 'pull_request', runId: RUN, ...over } as never);

describe('the Run request carries the suite of its environment', () => {
    it('fills the suite section when the recipe declares a suite: main commit, changed files and one token per claim bound to the Run', async () => {
        const w = world();
        const req = await build(w);
        expect(RuntimeRunRequestedSchema.safeParse(req).success).toBe(true);
        expect(req.suite).toMatchObject({ mainSha: MAIN, changedFiles: ['src/a.ts', 'src/new.ts', 'src/old.ts'] });
        // The listing, two shards, the fresh host and the main host: five claims.
        expect(req.suite!.moreRepoTokens).toHaveLength(4);
        const all = [req.suite!.repoToken, ...req.suite!.moreRepoTokens!];
        expect(new Set(all.map((t) => openSealed(t, RUN))).size).toBe(5);
    });

    it('sends the files the PR removes, and neither list when the diff was cut', async () => {
        const w = world({ removed: ['e2e/gone.cy.ts'] });
        expect((await build(w)).suite).toMatchObject({ removedFiles: ['e2e/gone.cy.ts'] });
        const cut = await build(world({ removed: ['e2e/gone.cy.ts'], truncated: true }));
        expect(cut.suite).not.toHaveProperty('changedFiles');
        expect(cut.suite).not.toHaveProperty('removedFiles');
    });

    it('carries the true merge base and how far main moved, bounded; and the PR base with no drift when the platform cannot say', async () => {
        const MERGE_BASE = 'e'.repeat(40);
        expect((await build(world({ compare: { mergeBase: MERGE_BASE, behindBy: 3 } }))).suite).toMatchObject({ mergeBase: MERGE_BASE, mainBehind: 3 });
        expect((await build(world({ compare: { mergeBase: MERGE_BASE, behindBy: 9_999 } }))).suite).toMatchObject({ mainBehind: 21 });
        for (const compare of ['unsupported_platform', null, 'throws', undefined]) {
            const suite = (await build(world({ compare }))).suite!;
            expect(suite).not.toHaveProperty('mainBehind');
            expect(suite).not.toHaveProperty('mergeBase');
        }
    });

    it('leaves the section out, and mints nothing for it, when the recipe has no suite', async () => {
        const w = world({ recipe: 'version: 1\nservices:\n  compose:\n    public: app\n' });
        const req = await build(w);
        expect(req).not.toHaveProperty('suite');
        // The Run's own three tokens only: base, PR and the Run token are minted by mintTokens (two repo tokens).
        expect(w.issued).toHaveLength(2);
    });

    it.each([
        ['an environment never set up, so with no main commit', { setup: { setupSha: null } }],
        ['a fork, whose code waits for a maintainer and whose tokens would expire', { over: { head: { ...head, fork: true } } }],
        ['a simulation', { over: { trigger: 'simulate' } }],
    ])('sends no suite for %s', async (_n, c) => {
        const w = world((c as { setup?: object }).setup);
        const req = await build(w, (c as { over?: object }).over);
        expect(req).not.toHaveProperty('suite');
        expect(w.issued.length).toBeLessThanOrEqual(2);
    });
});
