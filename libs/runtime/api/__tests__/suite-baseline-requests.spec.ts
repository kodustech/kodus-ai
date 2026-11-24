import type { ProductEnvironment, RuntimeGitPort } from '../domain/ports';
import { RuntimeSuiteBaselineRequests } from '../application/suite-baseline-requests.service';
import { FakeOutbox, NOW, ORG, REPO, SHA, TEAM, clock, config, openSealed, runtimeReleaseGate } from './fixtures';

jest.mock('@libs/core/log/logger', () => ({ createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

// docs/runtime/e2e-suites.md section 2.1: the fleet records a baseline request when a template turns ready (it holds no
// repository credentials); the product turns the queued ones into the `RuntimeSuiteRequested` command, with the tokens.

const SUITE_ID = '0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c11';
const SUITE = 'suite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: "cypress/e2e/**/*.cy.ts"\n';
const recipe = (extra = '') => `version: 1\nservices:\n  compose:\n    public: app\n${SUITE}${extra}`;

const env = (patch: Partial<ProductEnvironment> = {}): ProductEnvironment => ({ environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'active', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...patch });
const pendingRow = (over: Record<string, unknown> = {}) => ({ organizationId: ORG, environmentId: 'env-1', repositoryId: REPO, mainSha: SHA, suiteRunId: SUITE_ID, ...over });

function world(opts: { pending?: any[]; recipe?: string | null; released?: boolean; envs?: ProductEnvironment[]; tokenFails?: boolean } = {}) {
    const envs = opts.envs ?? [env()];
    const store = { get: async (o: string, e: string) => envs.find((x) => x.organizationId === o && x.environmentId === e) ?? null };
    const outbox = new FakeOutbox();
    const issued: string[] = [];
    const git = { readFileAtCommit: async () => (opts.recipe === undefined ? recipe() : opts.recipe) } as unknown as RuntimeGitPort;
    const tokens = { issue: async () => (opts.tokenFails ? Promise.reject(new Error('no token')) : (issued.push('t'), `ghs_download_${issued.length}`)) };
    const reader = { pending: jest.fn(async () => opts.pending ?? [pendingRow()]) };
    const step = new RuntimeSuiteBaselineRequests(reader, store as any, git, tokens, outbox as any, clock, config(), opts.released === undefined ? undefined : runtimeReleaseGate(opts.released));
    return { step, outbox, reader, issued };
}
const commands = (o: FakeOutbox) => o.rows.filter((r) => r.payload.event_name === 'runtime.suite.requested').map((r) => r.payload.payload);

describe('when the fleet is waiting for a baseline suite run of a main commit', () => {
    it('issues one suite_requested of mode baseline under the id the fleet chose, with the repository and sealed tokens bound to that id', async () => {
        const w = world();
        expect(await w.step.run()).toEqual({ pending: 1, requested: 1, skipped: 0, failed: 0 });
        const [cmd] = commands(w.outbox);
        expect(cmd).toMatchObject({ suiteRunId: SUITE_ID, key: SUITE_ID, organizationId: ORG, environmentId: 'env-1', repositoryId: REPO, repositoryFullName: 'acme/shop', mode: 'baseline', mainSha: SHA });
        expect(cmd.prNumber).toBeUndefined();
        expect(openSealed(cmd.repoToken, SUITE_ID)).toBe('ghs_download_1');
        // One token for the spec listing and one per shard (the recipe names no ceiling: the limit of 16), none for a re-run: a baseline has none.
        expect(cmd.moreRepoTokens).toHaveLength(16);
        expect(openSealed(cmd.moreRepoTokens[0], SUITE_ID)).toBe('ghs_download_2');
    });

    it('mints only the tokens the recipe can use: the listing and its shard ceiling', async () => {
        const w = world({ recipe: recipe('  shards: 3\n') });
        await w.step.run();
        expect(commands(w.outbox)[0].moreRepoTokens).toHaveLength(3);
        expect(w.issued).toHaveLength(4);
    });

    it('issues nothing, and mints nothing, when the recipe at that commit no longer declares a suite or turns the baseline off', async () => {
        for (const content of ['version: 1\nservices:\n  compose:\n    public: app\n', recipe('  baseline: false\n'), null]) {
            const w = world({ recipe: content });
            expect(await w.step.run()).toMatchObject({ requested: 0, skipped: 1, failed: 0 });
            expect(commands(w.outbox)).toEqual([]);
            expect(w.issued).toEqual([]);
        }
    });

    it('issues nothing for an environment the product does not know or an org the Runtime is not released to', async () => {
        const unknown = world({ envs: [] });
        const off = world({ released: false });
        expect(await unknown.step.run()).toMatchObject({ requested: 0, skipped: 1 });
        expect(await off.step.run()).toMatchObject({ requested: 0, skipped: 1 });
        expect([...commands(unknown.outbox), ...commands(off.outbox)]).toEqual([]);
    });

    it('asks for the same run once in this process, and never throws when a token or the read fails', async () => {
        const w = world();
        await w.step.run();
        expect(await w.step.run()).toMatchObject({ requested: 0, skipped: 1 });
        expect(commands(w.outbox)).toHaveLength(1);

        const noToken = world({ tokenFails: true });
        expect(await noToken.step.run()).toMatchObject({ requested: 0, failed: 1 });
        noToken.reader.pending.mockRejectedValueOnce(new Error('read down'));
        expect(await noToken.step.run()).toMatchObject({ failed: 1 });
    });
});
