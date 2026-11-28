import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { EnvironmentSetupState, RuntimeRunProjection } from '@libs/runtime/run';

import { ListPullRequestRunsUseCase, pullRequestsOf } from '../application/use-cases/pull-request-runs.use-case';
import { RequestPullRequestRunUseCase } from '../application/use-cases/request-pull-request-run.use-case';
import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import { RuntimeRunEnqueuer } from '../application/runtime-run-enqueuer.service';
import { deterministicUuid } from '../domain/deterministic-id';
import { COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY } from '../domain/trigger-rules';
import type { ProductEnvironment, PullRequestHead, RuntimeRepositorySettingsRecord } from '../domain/ports';
import {
    MAX_PULL_REQUESTS_PER_READ,
    groupPullRequestRuns,
    pullRequestRunView,
    type PullRequestRef,
    type PullRequestRunRecord,
    type PullRequestRunsReader,
} from '../domain/pull-request-runs';
import { BASE_SHA, clock, config, FakeOutbox, ORG, OTHER_ORG, OTHER_REPO, realAuthorization, REPO, run, SHA, storeWith, TEAM, user } from './fixtures';
import { InMemoryRunTargetStore } from '@libs/runtime-publish/testing';

const owner = user(Role.OWNER);
const contributor = user(Role.CONTRIBUTOR);
const billing = user(Role.BILLING_MANAGER);
const OLD_SHA = 'c'.repeat(40);

const finding = (patch: Partial<NonNullable<RuntimeRunProjection['findings']>[number]> = {}) => ({
    probeId: 'p1',
    entryPoint: 'GET /orders',
    verdict: 'finding' as const,
    reason: 'differs',
    differingFields: ['items[0].quantity'],
    responseDiff: { fields: [{ path: 'items[0].quantity', base: '2', pr: '""' }], truncated: false },
    ...patch,
});

/** A reader over in-memory Runs that counts its calls, like the Postgres one: org-matched, newest first. */
class CountingReader implements PullRequestRunsReader {
    calls: Array<{ organizationId: string; pullRequests: PullRequestRef[] }> = [];
    setupCalls = 0;
    constructor(
        private readonly runs: RuntimeRunProjection[],
        private readonly setups: Map<string, EnvironmentSetupState> = new Map([['env-1', 'active']]),
        private readonly ignoreOrg = false,
    ) {}
    async listForPullRequests(input: { organizationId: string; pullRequests: PullRequestRef[]; perPullRequest: number }): Promise<PullRequestRunRecord[]> {
        this.calls.push({ organizationId: input.organizationId, pullRequests: input.pullRequests });
        return this.runs.filter(
            (r) => (this.ignoreOrg || r.organizationId === input.organizationId) && input.pullRequests.some((p) => p.repositoryId === r.repositoryId && p.prNumber === r.prNumber),
        );
    }
    async setupStates(_org: string, ids: string[]) {
        this.setupCalls += 1;
        return new Map([...this.setups].filter(([id]) => ids.includes(id)));
    }
}

const environment = (patch: Partial<ProductEnvironment> = {}): ProductEnvironment => ({
    environmentId: 'env-1',
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: REPO,
    repositoryName: 'acme/shop',
    state: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
});

const onSettings: RuntimeRepositorySettingsRecord[] = [{ repositoryId: REPO, pilot: true, whoCanAsk: 'writers', mode: 'on_request' }];

const listWith = (reader: PullRequestRunsReader, opts: { scope?: string[] | null; envs?: ProductEnvironment[]; settings?: RuntimeRepositorySettingsRecord[]; auth?: any } = {}) =>
    new ListPullRequestRunsUseCase(
        reader,
        { listByOrganization: async (org: string) => (opts.envs ?? [environment()]).filter((e) => e.organizationId === org) },
        { listRepositories: async () => opts.settings ?? onSettings },
        opts.auth ?? (opts.scope === undefined ? realAuthorization() : { ensure: async () => undefined, getRepositoryScope: async () => opts.scope }),
    );

describe('POST /runtime/pull-request-runs', () => {
    it('reads the whole page in one query, whatever the number of PRs and repositories', async () => {
        const reader = new CountingReader([run({ prNumber: 1 }), run({ prNumber: 2 }), run({ prNumber: 3, repositoryId: OTHER_REPO })]);
        const res = await listWith(reader, { scope: null }).execute({
            user: owner,
            body: { pullRequests: [{ repositoryId: REPO, prNumber: 1 }, { repositoryId: REPO, prNumber: 2 }, { repositoryId: OTHER_REPO, prNumber: 3 }] },
        });
        expect(reader.calls).toHaveLength(1);
        expect(reader.setupCalls).toBe(1);
        expect(reader.calls[0].pullRequests).toHaveLength(3);
        expect(res.pullRequests.map((p) => [p.repositoryId, p.prNumber, !!p.latest])).toEqual([
            [REPO, 1, true],
            [REPO, 2, true],
            [OTHER_REPO, 3, true],
        ]);
    });

    it('is org-scoped: it asks for the caller org only, and drops a Run of another org a store would hand back', async () => {
        const reader = new CountingReader([run({ organizationId: OTHER_ORG, runId: 'foreign' })], undefined, true);
        const res = await listWith(reader, { scope: null }).execute({ user: owner, body: { pullRequests: [{ repositoryId: REPO, prNumber: 7 }] } });
        expect(reader.calls[0].organizationId).toBe(ORG);
        expect(res.pullRequests[0].latest).toBeNull();
        // Another org's environment never shows either.
        const other = await listWith(new CountingReader([]), { scope: null, envs: [environment({ organizationId: OTHER_ORG })] }).execute({
            user: owner,
            body: { pullRequests: [{ repositoryId: REPO, prNumber: 7 }] },
        });
        expect(other.pullRequests[0].environment).toBeNull();
    });

    it('leaves out the PRs of repositories the caller cannot read, without reading them', async () => {
        const reader = new CountingReader([run(), run({ repositoryId: OTHER_REPO })]);
        const res = await listWith(reader, { scope: [REPO] }).execute({
            user: contributor,
            body: { pullRequests: [{ repositoryId: REPO, prNumber: 7 }, { repositoryId: OTHER_REPO, prNumber: 7 }] },
        });
        expect(reader.calls[0].pullRequests).toEqual([{ repositoryId: REPO, prNumber: 7 }]);
        expect(res.pullRequests.map((p) => p.repositoryId)).toEqual([REPO]);

        const none = new CountingReader([run()]);
        expect(await listWith(none, { scope: [] }).execute({ user: contributor, body: { pullRequests: [{ repositoryId: REPO, prNumber: 7 }] } })).toEqual({ pullRequests: [] });
        expect(none.calls).toHaveLength(0);
    });

    it('with the real permissions: an owner reads, a billing manager reads nothing', async () => {
        const body = { pullRequests: [{ repositoryId: REPO, prNumber: 7 }] };
        expect((await listWith(new CountingReader([run()])).execute({ user: owner, body })).pullRequests).toHaveLength(1);
        const reader = new CountingReader([run()]);
        const denied = await listWith(reader)
            .execute({ user: billing, body })
            .catch((e: unknown) => e);
        // Either refused or empty: never a Run.
        if (denied instanceof Error) expect(denied).toBeInstanceOf(ForbiddenException);
        else expect(denied).toEqual({ pullRequests: [] });
        expect(reader.calls).toHaveLength(0);
    });

    it('answers the environment: ready once its setup is active, and whether Runtime is on', async () => {
        const body = { pullRequests: [{ repositoryId: REPO, prNumber: 7 }] };
        const ready = await listWith(new CountingReader([])).execute({ user: owner, body });
        expect(ready.pullRequests[0]).toMatchObject({ environment: { environmentId: 'env-1', name: 'acme/shop', ready: true, on: true }, latest: null, commits: [] });
        const settingUp = await listWith(new CountingReader([], new Map([['env-1', 'setting_up']])), { settings: [] }).execute({ user: owner, body });
        expect(settingUp.pullRequests[0].environment).toMatchObject({ ready: false, on: false });
        const none = await listWith(new CountingReader([]), { envs: [] }).execute({ user: owner, body });
        expect(none.pullRequests[0].environment).toBeNull();
    });

    it('validates the list: 1 to the cap, positive PR numbers, duplicates once', () => {
        expect(() => pullRequestsOf({ pullRequests: [] })).toThrow(BadRequestException);
        expect(() => pullRequestsOf({})).toThrow(BadRequestException);
        expect(() => pullRequestsOf({ pullRequests: [{ repositoryId: REPO, prNumber: 0 }] })).toThrow(BadRequestException);
        expect(() => pullRequestsOf({ pullRequests: [{ repositoryId: '', prNumber: 1 }] })).toThrow(BadRequestException);
        const many = Array.from({ length: MAX_PULL_REQUESTS_PER_READ + 1 }, (_, i) => ({ repositoryId: REPO, prNumber: i + 1 }));
        expect(() => pullRequestsOf({ pullRequests: many })).toThrow(BadRequestException);
        expect(pullRequestsOf({ pullRequests: [{ repositoryId: REPO, prNumber: 1 }, { repositoryId: REPO, prNumber: 1 }] })).toEqual([{ repositoryId: REPO, prNumber: 1 }]);
    });
});

describe('pull request Run views', () => {
    it('keeps the latest Run, and the latest Run of each commit, newest first', () => {
        const old = run({ runId: 'old', headSha: OLD_SHA, requestedAt: '2026-10-29T09:00:00.000Z', state: 'no_regressions', findings: [] });
        const first = run({ runId: 'first', requestedAt: '2026-10-29T10:00:00.000Z' });
        const again = run({ runId: 'again', attempt: 2, requestedAt: '2026-10-29T11:00:00.000Z' });
        const grouped = groupPullRequestRuns([first, old, again]).get(`${REPO}#7`)!;
        expect(grouped.latest.runId).toBe('again');
        expect(grouped.commits.map((c) => [c.runId, c.headSha])).toEqual([
            ['again', SHA],
            ['old', OLD_SHA],
        ]);
    });

    it('counts regressions once across findings and probes, never an intended one, and says the first in fields', () => {
        const view = pullRequestRunView(
            run({
                findings: [finding(), finding({ probeId: 'p2', intent: 'intended' })],
                probes: [finding(), finding({ probeId: 'p3', verdict: 'not_reproduced' })],
                reproduction: { probes: [{ probeId: 'p1', purpose: 'Orders page lists the quantity', expected: 'x', spec: { kind: 'sql', query: 'select 1' } } as any] },
                bootFailure: { side: 'base', kind: 'platform', signature: 's', title: 't', logTail: [], at: '2026-10-29T10:00:00.000Z' } as any,
            }),
        );
        expect(view.regressions).toBe(1);
        expect(view.probes).toBe(2);
        expect(view.bootFailureSide).toBe('base');
        expect(view.firstRegression).toEqual({
            title: 'Orders page lists the quantity',
            field: { path: 'items[0].quantity', base: '2', pr: '""' },
            differingFields: ['items[0].quantity'],
            boot: false,
            destabilizes: false,
        });
        expect(pullRequestRunView(run({ state: 'no_regressions', findings: [] }))).not.toHaveProperty('firstRegression');
    });

    it('carries the status change of the first regression, so the list leads with it before the body difference', () => {
        const view = pullRequestRunView(
            run({
                findings: [finding({ entryPoint: 'POST /orders', statusChange: { base: 201, pr: 400 }, differingFields: ['status', 'json.id'], responseDiff: { fields: [{ path: 'json.id', base: '3' }], truncated: false } })],
            }),
        );
        expect(view.firstRegression).toMatchObject({ status: { base: 201, pr: 400 }, field: { path: 'json.id', base: '3' } });
    });

    it('counts a 5xx on an endpoint the PR adds as an error on a new endpoint, never as a regression', () => {
        const newEndpoint = finding({ probeId: 'p4', entryPoint: 'POST /orders/preview', findingKind: 'new_endpoint_error' } as any);
        const view = pullRequestRunView(run({ state: 'regression', findings: [newEndpoint], probes: [newEndpoint] }));
        expect(view).toMatchObject({ state: 'regression', regressions: 0, newEndpointErrors: 1 });
        expect(view).not.toHaveProperty('firstRegression');
        const both = pullRequestRunView(run({ state: 'regression', findings: [finding(), newEndpoint, { ...newEndpoint, probeId: 'p5', intent: 'intended' } as any] }));
        expect(both).toMatchObject({ regressions: 1, newEndpointErrors: 1, firstRegression: { field: { path: 'items[0].quantity' } } });
        expect(pullRequestRunView(run({ findings: [finding()] }))).not.toHaveProperty('newEndpointErrors');
    });
});

describe('POST /runtime/pull-request-runs/request', () => {
    const setup = async (opts: { runs?: RuntimeRunProjection[]; setup?: EnvironmentSetupState; setupUnreadable?: boolean; settings?: RuntimeRepositorySettingsRecord[]; head?: PullRequestHead | null; env?: ProductEnvironment | null } = {}) => {
        const store = await storeWith(...(opts.runs ?? []));
        const head: PullRequestHead | null = opts.head === undefined ? { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'open' } : opts.head;
        const git = {
            getPullRequestHead: async () => head,
            getPullRequestDiff: async () => ({ files: [{ path: 'src/a.ts', patch: '@@' }], truncated: false }),
        };
        const outbox = new FakeOutbox();
        const targets = new InMemoryRunTargetStore();
        const enqueuer = new RuntimeRunEnqueuer(targets, outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
        const builder = new RuntimeRunRequestBuilder(
            git as any,
            { issue: async () => 'repo-token' },
            { get: async () => ({ environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, imageId: 'img-1' }) },
            config(),
            clock,
        );
        const env = opts.env === undefined ? environment() : opts.env;
        const uc = new RequestPullRequestRunUseCase(
            realAuthorization(),
            { findByRepository: async (org: string, repo: string) => (env && env.organizationId === org && env.repositoryId === repo ? env : null) },
            { get: async () => { if (opts.setupUnreadable) throw new Error('connection terminated'); return { state: opts.setup ?? 'active' } as any; } },
            { listRepositories: async () => opts.settings ?? onSettings },
            store,
            git as any,
            builder,
            enqueuer,
            config(),
        );
        return { uc, outbox, targets };
    };
    const body = { repositoryId: REPO, prNumber: 7 };

    it('enqueues a Run on the current head, with its publish target, and a repeated ask is the next attempt', async () => {
        const { uc, outbox, targets } = await setup();
        const res = await uc.execute({ user: owner, body });
        expect(res).toEqual({ runId: deterministicUuid('dashboard', ORG, REPO, 7, SHA, 1), attempt: 1, state: 'queued' });
        expect(outbox.rows).toHaveLength(1);
        expect(outbox.rows[0].payload.payload).toMatchObject({ trigger: 'run_again', pullRequest: { number: 7, headSha: SHA } });
        expect(await targets.get(res.runId)).toMatchObject({ repositoryId: REPO, pullRequestNumber: 7, headSha: SHA });

        const done = run({ headSha: SHA, attempt: 1, state: 'regression' });
        expect((await (await setup({ runs: [done] })).uc.execute({ user: owner, body })).attempt).toBe(2);
    });

    it('is a write: a contributor who only reads Runs is refused, and nothing is enqueued', async () => {
        const { uc, outbox } = await setup();
        await expect(uc.execute({ user: contributor, body })).rejects.toBeInstanceOf(ForbiddenException);
        expect(outbox.rows).toHaveLength(0);
    });

    it("a fork PR asked from Kodus follows the environment's fork policy: skip starts nothing, the default waits for a maintainer, run starts it", async () => {
        const forkHead: PullRequestHead = { headSha: SHA, baseSha: BASE_SHA, fork: true, state: 'open', authorId: '42' };
        const skip = await setup({ head: forkHead, env: environment({ forkPullRequests: 'skip' }) });
        await expect(skip.uc.execute({ user: owner, body })).rejects.toThrow('fork policy skips');
        expect(skip.outbox.rows).toHaveLength(0);

        const held = await setup({ head: forkHead });
        await held.uc.execute({ user: owner, body });
        expect(held.outbox.rows[0].payload.payload.pullRequest).toMatchObject({ fork: true });
        expect(held.outbox.rows[0].payload.payload.pullRequest.forkApprovalRequired).toBeUndefined();

        const open = await setup({ head: forkHead, env: environment({ forkPullRequests: 'run' }) });
        await open.uc.execute({ user: owner, body });
        expect(open.outbox.rows[0].payload.payload.pullRequest).toMatchObject({ fork: true, forkApprovalRequired: false });
    });

    it('Run on this PR stops at the daily count of Runs asked by hand on that pull request, the one @kody runtime counts too', async () => {
        const recent = new Date().toISOString();
        const sha = (i: number) => i.toString(16).padStart(40, 'd');
        const asked = Array.from({ length: COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY }, (_, i) => run({ trigger: i % 2 ? 'comment' : 'run_again', headSha: sha(i), requestedAt: recent }));
        const full = await setup({ runs: asked });
        const refused = await full.uc.execute({ user: owner, body }).catch((e: any) => e);
        expect(refused.getStatus()).toBe(429);
        expect(refused.message).toContain(`${COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY} Runs asked by hand`);
        expect(full.outbox.rows).toHaveLength(0);

        // Runs older than a day no longer count.
        const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        await expect((await setup({ runs: asked.map((r) => ({ ...r, requestedAt: old })) })).uc.execute({ user: owner, body })).resolves.toMatchObject({ state: 'queued' });
    });

    it('refuses without a ready environment, with Runtime off, on a closed PR, or while a Run of that head is live', async () => {
        await expect((await setup({ env: null })).uc.execute({ user: owner, body })).rejects.toBeInstanceOf(NotFoundException);
        await expect((await setup({ env: environment({ organizationId: OTHER_ORG }) })).uc.execute({ user: owner, body })).rejects.toBeInstanceOf(NotFoundException);
        await expect((await setup({ setup: 'setting_up' })).uc.execute({ user: owner, body })).rejects.toThrow('not ready');
        await expect((await setup({ settings: [] })).uc.execute({ user: owner, body })).rejects.toThrow('off');
        await expect((await setup({ head: { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'closed' } })).uc.execute({ user: owner, body })).rejects.toBeInstanceOf(ConflictException);
        await expect((await setup({ head: null })).uc.execute({ user: owner, body })).rejects.toBeInstanceOf(NotFoundException);
        await expect((await setup({ runs: [run({ state: 'testing' })] })).uc.execute({ user: owner, body })).rejects.toThrow('still running');
        await expect((await setup()).uc.execute({ user: owner, body: { repositoryId: REPO, prNumber: -1 } })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers unavailable, not "not ready", when the setup store cannot be read, and enqueues nothing', async () => {
        const { uc, outbox } = await setup({ setupUnreadable: true });
        const error = await uc.execute({ user: owner, body }).catch((e) => e);
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect(String(error.message)).not.toContain('connection terminated');
        expect(outbox.rows).toHaveLength(0);
    });
});
