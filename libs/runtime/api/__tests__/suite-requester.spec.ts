import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { InMemoryRunTargetStore } from '@libs/runtime-publish/testing';

import { RuntimeSuiteRequester } from '../application/suite-requester.service';
import type { ProductEnvironment, RuntimeGitPort } from '../domain/ports';
import { FakeOutbox, NOW, ORG, REPO, SHA, TEAM, clock, config, openSealed, runtimeReleaseGate } from './fixtures';

jest.mock('@libs/core/log/logger', () => ({ createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

// docs/runtime/e2e-suites.md sections 2.2 and 11: CI mode. A pull request asks for the suite: a command with the PR's files and
// one sealed download token per claim, and the publish target the suite's check is written under. No Kody verdict, no probes.

const MAIN = 'd'.repeat(40);
const HEAD = SHA;
const BASE = 'b'.repeat(40);
const SUITE = 'suite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: "cypress/e2e/**/*.cy.ts"\n  shards: 2\n';
const recipe = `version: 1\nservices:\n  compose:\n    public: app\n${SUITE}`;
const env = (patch: Partial<ProductEnvironment> = {}): ProductEnvironment => ({ environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'active', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...patch });

function world(o: { head?: Partial<Awaited<ReturnType<RuntimeGitPort['getPullRequestHead']>> & object> | null; recipe?: string | null; setupSha?: string | null; setupRecipe?: { content: string; origin: string; sha?: string }; released?: boolean; truncated?: boolean; diff?: Array<{ path: string; previousPath?: string }>; removed?: string[]; compare?: unknown } = {}) {
    const outbox = new FakeOutbox();
    const targets = new InMemoryRunTargetStore();
    const issued: string[] = [];
    const compared: unknown[] = [];
    const git = {
        getPullRequestHead: async () => (o.head === null ? null : { headSha: HEAD, baseSha: BASE, fork: false, state: 'open', ...o.head }),
        getPullRequestDiff: async () => ({ files: (o.diff ?? [{ path: 'src/a.ts' }, { path: 'src/new.ts', previousPath: 'src/old.ts' }]).map((f) => ({ patch: '', ...f })), truncated: !!o.truncated, ...(o.removed ? { removedFiles: o.removed } : {}) }),
        readFileAtCommit: async () => (o.recipe === undefined ? recipe : o.recipe),
        ...(o.compare === 'absent' ? {} : { compareWithMain: async (i: unknown) => (compared.push(i), o.compare === 'throws' ? Promise.reject(new Error('git api down')) : ('compare' in o ? o.compare : { mergeBase: BASE, behindBy: 1 })) }),
    } as unknown as RuntimeGitPort;
    const tokens = { issue: async () => (issued.push('t'), `ghs_${issued.length}`) };
    const setups = { get: async () => (o.setupSha === null ? null : { sha: o.setupSha ?? MAIN, ...(o.setupRecipe ? { recipe: { path: '.kodus/workspace.yaml', state: 'found', sha: o.setupRecipe.sha ?? o.setupSha ?? MAIN, content: o.setupRecipe.content, origin: o.setupRecipe.origin } } : {}) }) };
    const store = { get: async () => env() };
    const step = new RuntimeSuiteRequester(store as any, git, tokens, outbox as any, clock, config(), setups as any, targets, { getTypeIntegration: async () => PlatformType.GITHUB }, o.released === undefined ? undefined : runtimeReleaseGate(o.released));
    return { step, outbox, targets, issued, compared };
}
const commands = (ob: FakeOutbox) => ob.rows.filter((r) => r.payload.event_name === 'runtime.suite.requested').map((r) => r.payload.payload);

describe('asking for the suite of a pull request (CI mode)', () => {
    // A design partner's monorepo would have had no e2e until someone committed .kodus/: the Runs already boot the recipe Kody
    // wrote, and the suite now runs from it too. A recipe committed in the repository still decides, a suite or none.
    describe("the suite of the recipe the environment booted, when the repository has none committed", () => {
        it('runs from the recipe Kody wrote and the environment booted at the main commit', async () => {
            const w = world({ recipe: null, setupRecipe: { content: recipe, origin: 'authored' } });
            expect(await w.step.requestCi({ environment: env(), prNumber: 42 })).toMatchObject({ status: 'requested' });
            expect(commands(w.outbox)[0]).toMatchObject({ mode: 'ci', mainSha: MAIN, suiteSource: 'environment' });
        });

        it('says the suite came from the repository when it is committed', async () => {
            const w = world({ setupRecipe: { content: recipe, origin: 'authored' } });
            await w.step.requestCi({ environment: env(), prNumber: 42 });
            expect(commands(w.outbox)[0]).toMatchObject({ suiteSource: 'repository' });
        });

        it('runs nothing when the committed recipe declares no suite, whatever the environment booted', async () => {
            const w = world({ recipe: 'version: 1\nservices:\n  compose:\n    public: app\n', setupRecipe: { content: recipe, origin: 'authored' } });
            expect(await w.step.requestCi({ environment: env(), prNumber: 42 })).toEqual({ status: 'skipped', reason: 'no_suite' });
        });

        it('runs nothing from a recipe booted at another commit than the main one', async () => {
            const w = world({ recipe: null, setupRecipe: { content: recipe, origin: 'authored', sha: 'f'.repeat(40) } });
            expect(await w.step.requestCi({ environment: env(), prNumber: 42 })).toEqual({ status: 'skipped', reason: 'no_suite' });
        });
    });

    it('issues one suite_requested of mode ci with the PR, the main commit of the template, the changed files and one token per claim', async () => {
        const w = world();
        const out = await w.step.requestCi({ environment: env(), prNumber: 42 });
        expect(out).toMatchObject({ status: 'requested' });
        const [cmd] = commands(w.outbox);
        expect(cmd).toMatchObject({ mode: 'ci', organizationId: ORG, environmentId: 'env-1', repositoryId: REPO, repositoryFullName: 'acme/shop', prNumber: 42, prSha: HEAD, mergeBase: BASE, mainSha: MAIN });
        expect(cmd.suiteRunId).toBe(cmd.key);
        // A rename is both paths: the old one selects too.
        expect(cmd.changedFiles).toEqual(['src/a.ts', 'src/new.ts', 'src/old.ts']);
        // The listing, two shards, the fresh host and the main host: five claims, the first token in repoToken.
        expect(cmd.moreRepoTokens).toHaveLength(4);
        expect(w.issued).toHaveLength(5);
        expect(openSealed(cmd.repoToken, cmd.key)).toBe('ghs_1');
    });

    it('sends the files the PR removes, so the suite does not run a spec the PR deletes, and none when the diff was cut', async () => {
        const w = world({ removed: ['e2e/gone.cy.ts', 'e2e/old.cy.ts'] });
        await w.step.requestCi({ environment: env(), prNumber: 42 });
        expect(commands(w.outbox)[0].removedFiles).toEqual(['e2e/gone.cy.ts', 'e2e/old.cy.ts']);
        const cut = world({ removed: ['e2e/gone.cy.ts'], truncated: true });
        await cut.step.requestCi({ environment: env(), prNumber: 42 });
        expect(commands(cut.outbox)[0]).not.toHaveProperty('removedFiles');
        const none = world();
        await none.step.requestCi({ environment: env(), prNumber: 42 });
        expect(commands(none.outbox)[0]).not.toHaveProperty('removedFiles');
    });

    describe('how far main moved (the platform compare API)', () => {
        const MERGE_BASE = 'e'.repeat(40);
        const ask = async (compare: unknown, over: Parameters<typeof world>[0] = {}) => {
            const w = world({ compare, ...over });
            await w.step.requestCi({ environment: env(), prNumber: 42 });
            return { cmd: commands(w.outbox)[0], w };
        };

        it('puts the true merge base in the command, not the base the PR was opened against, and how many commits main is ahead of it', async () => {
            const { cmd, w } = await ask({ mergeBase: MERGE_BASE, behindBy: 3 });
            expect(cmd).toMatchObject({ mergeBase: MERGE_BASE, mainSha: MAIN, mainBehind: 3 });
            expect(w.compared).toEqual([expect.objectContaining({ main: MAIN, head: HEAD })]);
        });

        it('counts no further than the classifier needs (21: one past the 20 commits a baseline may lag), so the answer stays bounded', async () => {
            expect((await ask({ mergeBase: MERGE_BASE, behindBy: 4_000 })).cmd.mainBehind).toBe(21);
        });

        it('a merge base that is main itself is a drift of zero', async () => {
            expect((await ask({ mergeBase: MAIN, behindBy: 0 })).cmd).toMatchObject({ mergeBase: MAIN, mainBehind: 0 });
        });

        it.each([
            ['a platform with no compare API', 'unsupported_platform'],
            ['commits the API does not know', null],
            ['a Git API that failed', 'throws'],
            ['a git port with no compare at all', 'absent'],
        ])('keeps the base the PR was opened against and claims no drift for %s', async (_n, compare) => {
            const { cmd } = await ask(compare);
            expect(cmd.mergeBase).toBe(BASE);
            expect(cmd).not.toHaveProperty('mainBehind');
        });
    });

    it('stores the publish target under the suite run id before the command, so the check can be written', async () => {
        const w = world();
        await w.step.requestCi({ environment: env(), prNumber: 42 });
        const [cmd] = commands(w.outbox);
        expect(await w.targets.get(cmd.suiteRunId)).toMatchObject({ runId: cmd.suiteRunId, attempt: 1, organizationId: ORG, repositoryId: REPO, pullRequestNumber: 42, headSha: HEAD, platform: PlatformType.GITHUB, fork: false });
    });

    it('the same push is the same suite run, and a new push is another', async () => {
        const w = world();
        await w.step.requestCi({ environment: env(), prNumber: 42 });
        await w.step.requestCi({ environment: env(), prNumber: 42 });
        const w2 = world({ head: { headSha: 'e'.repeat(40) } });
        await w2.step.requestCi({ environment: env(), prNumber: 42 });
        const [a, b] = commands(w.outbox);
        expect(a.suiteRunId).toBe(b.suiteRunId);
        expect(commands(w2.outbox)[0].suiteRunId).not.toBe(a.suiteRunId);
    });

    it('leaves the changed files out when the diff was cut: unknown is never a short list', async () => {
        const w = world({ truncated: true });
        await w.step.requestCi({ environment: env(), prNumber: 42 });
        expect(commands(w.outbox)[0]).not.toHaveProperty('changedFiles');
    });

    it.each([
        ['a fork, which waits for a maintainer before any code of it runs', { head: { fork: true } }, 'fork'],
        ['a draft, which has no suite run until it is ready for review', { head: { draft: true } }, 'draft'],
        ['a closed pull request', { head: { state: 'closed' as const } }, 'not_open'],
        ['a pull request the Git API does not know', { head: null }, 'no_pull_request'],
        ['an environment whose recipe declares no suite', { recipe: 'version: 1\nservices:\n  compose:\n    public: app\n' }, 'no_suite'],
        ['an environment that was never set up, so there is no main commit', { setupSha: null }, 'no_setup'],
        ['an org the Runtime is not released to', { released: false }, 'not_released'],
    ])('asks for nothing, and mints nothing, for %s', async (_n, opts, reason) => {
        const w = world(opts as never);
        expect(await w.step.requestCi({ environment: env(), prNumber: 42 })).toEqual({ status: 'skipped', reason });
        expect(commands(w.outbox)).toEqual([]);
        expect(w.issued).toEqual([]);
    });
});
