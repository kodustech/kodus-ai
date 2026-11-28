import type { ProductEnvironment, RuntimeGitPort } from '../domain/ports';
import { RuntimeSuiteInputs } from '../application/suite-inputs.service';
import { RuntimeSuiteShadowRequests } from '../application/suite-shadow-requests.service';
import { FakeOutbox, NOW, ORG, REPO, SHA, TEAM, clock, config, openSealed, runtimeReleaseGate } from './fixtures';

jest.mock('@libs/core/log/logger', () => ({ createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

// docs/runtime/e2e-suites.md section 6.1 (Proof b) and D14: the Runtime records the shadow of a selected PR run (it holds no repository
// credentials); the product turns the queued ones into `RuntimeSuiteRequested` of mode `shadow`, with the tokens.

const SHADOW_ID = '0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c22';
const HEAD = 'b'.repeat(40);
const SUITE = 'suite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: "cypress/e2e/**/*.cy.ts"\n';
const recipe = (extra = '') => `version: 1\nservices:\n  compose:\n    public: app\n${SUITE}${extra}`;
const env = (patch: Partial<ProductEnvironment> = {}): ProductEnvironment => ({ environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'active', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...patch });
const pendingRow = (over: Record<string, unknown> = {}) => ({ organizationId: ORG, environmentId: 'env-1', repositoryId: REPO, shadowRunId: SHADOW_ID, prNumber: 7, prSha: HEAD, mergeBase: SHA, mainSha: SHA, changedFiles: ['src/a.ts', 'cypress/e2e/new.cy.ts'], removedFiles: ['cypress/e2e/old.cy.ts'], ...over });

function world(opts: { pending?: any[]; recipe?: string | null; released?: boolean; envs?: ProductEnvironment[]; tokenFails?: boolean } = {}) {
    const envs = opts.envs ?? [env()];
    const store = { get: async (o: string, e: string) => envs.find((x) => x.organizationId === o && x.environmentId === e) ?? null };
    const outbox = new FakeOutbox();
    const issued: string[] = [];
    const git = { readFileAtCommit: async () => (opts.recipe === undefined ? recipe() : opts.recipe) } as unknown as RuntimeGitPort;
    const tokens = { issue: async () => (opts.tokenFails ? Promise.reject(new Error('no token')) : (issued.push('t'), `ghs_download_${issued.length}`)) };
    const inputs = new RuntimeSuiteInputs(git as never, tokens, config(), { get: async () => null } as never);
    const reader = { pending: jest.fn(async () => opts.pending ?? [pendingRow()]) };
    const step = new RuntimeSuiteShadowRequests(reader, store as any, git, inputs, outbox as any, clock, config(), opts.released === undefined ? undefined : runtimeReleaseGate(opts.released));
    return { step, outbox, reader, issued };
}
const commands = (o: FakeOutbox) => o.rows.filter((r) => r.payload.event_name === 'runtime.suite.requested').map((r) => r.payload.payload);

describe('when the Runtime is waiting for the shadow of a selected PR run', () => {
    it('issues one suite_requested of mode shadow under the id the Runtime chose, for the PR head, with the files the PR added or removed and sealed tokens bound to that id', async () => {
        const w = world();
        expect(await w.step.run()).toEqual({ pending: 1, requested: 1, skipped: 0, failed: 0 });
        const [cmd] = commands(w.outbox);
        expect(cmd).toMatchObject({ suiteRunId: SHADOW_ID, key: SHADOW_ID, organizationId: ORG, environmentId: 'env-1', repositoryId: REPO, repositoryFullName: 'acme/shop', mode: 'shadow', prNumber: 7, prSha: HEAD, mergeBase: SHA, mainSha: SHA });
        expect(cmd.changedFiles).toEqual(['src/a.ts', 'cypress/e2e/new.cy.ts']);
        expect(cmd.removedFiles).toEqual(['cypress/e2e/old.cy.ts']);
        expect(openSealed(cmd.repoToken, SHADOW_ID)).toBe('ghs_download_1');
        // The listing, each shard of the ceiling (16 when the recipe names none), the fresh host and the main host: one token each.
        expect(cmd.moreRepoTokens).toHaveLength(16 + 2);
    });

    it('mints only the tokens the recipe can use', async () => {
        const w = world({ recipe: recipe('  shards: 2\n') });
        await w.step.run();
        expect(w.issued).toHaveLength(2 + 3);
    });

    it('issues nothing, and mints nothing, when the recipe at main no longer declares a suite', async () => {
        for (const content of ['version: 1\nservices:\n  compose:\n    public: app\n', null]) {
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

    it('asks for the same shadow once in this process, and never throws when a token or the read fails', async () => {
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
