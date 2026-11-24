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

function world(o: { head?: Partial<Awaited<ReturnType<RuntimeGitPort['getPullRequestHead']>> & object> | null; recipe?: string | null; setupSha?: string | null; released?: boolean; truncated?: boolean; diff?: Array<{ path: string; previousPath?: string }> } = {}) {
    const outbox = new FakeOutbox();
    const targets = new InMemoryRunTargetStore();
    const issued: string[] = [];
    const git = {
        getPullRequestHead: async () => (o.head === null ? null : { headSha: HEAD, baseSha: BASE, fork: false, state: 'open', ...o.head }),
        getPullRequestDiff: async () => ({ files: (o.diff ?? [{ path: 'src/a.ts' }, { path: 'src/new.ts', previousPath: 'src/old.ts' }]).map((f) => ({ patch: '', ...f })), truncated: !!o.truncated }),
        readFileAtCommit: async () => (o.recipe === undefined ? recipe : o.recipe),
    } as unknown as RuntimeGitPort;
    const tokens = { issue: async () => (issued.push('t'), `ghs_${issued.length}`) };
    const setups = { get: async () => (o.setupSha === null ? null : { sha: o.setupSha ?? MAIN }) };
    const store = { get: async () => env() };
    const step = new RuntimeSuiteRequester(store as any, git, tokens, outbox as any, clock, config(), setups as any, targets, { getTypeIntegration: async () => PlatformType.GITHUB }, o.released === undefined ? undefined : runtimeReleaseGate(o.released));
    return { step, outbox, targets, issued };
}
const commands = (ob: FakeOutbox) => ob.rows.filter((r) => r.payload.event_name === 'runtime.suite.requested').map((r) => r.payload.payload);

describe('asking for the suite of a pull request (CI mode)', () => {
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
