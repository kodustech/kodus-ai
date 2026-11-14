import { ConflictException, ForbiddenException, NotFoundException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import { Action, Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { loadS3EvidenceConfig } from '@libs/runtime/contracts/evidence-s3';
import { InMemoryRunStreamStore, RuntimeRunRequestedSchema } from '@libs/runtime/run';

import { RuntimeRunAccessService, type RuntimePrincipal } from '../application/run-access.service';
import { ApproveForkRunUseCase } from '../application/use-cases/approve-fork-run.use-case';
import { GetRuntimeRunEvidenceUseCase } from '../application/use-cases/get-run-evidence.use-case';
import { RuntimeRunCostService } from '../application/run-cost.service';
import { GetRuntimeRunUseCase } from '../application/use-cases/get-run.use-case';
import { ListRuntimeRunsUseCase } from '../application/use-cases/list-runs.use-case';
import { ReadRuntimeRunStreamUseCase } from '../application/use-cases/read-run-stream.use-case';
import { RunRuntimeAgainUseCase } from '../application/use-cases/run-again.use-case';
import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import { RuntimeRunEnqueuer, runTargetOf } from '../application/runtime-run-enqueuer.service';
import { InMemoryRunTargetStore } from '@libs/runtime-publish/domain/run-target';
import { InMemoryPublicationStore } from '@libs/runtime-publish/domain/runtime-publication';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { verifyRunToken } from '../domain/run-token';
import { RuntimeForkApprovedSchema } from '@libs/runtime/contracts/runtime-commands';
import type { GitIdentity, PullRequestHead, RuntimeGitPort } from '../domain/ports';
import {
    BASE_SHA,
    clock,
    config,
    FakeOutbox,
    InMemoryLlmUsage,
    NOW,
    ORG,
    OTHER_ORG,
    OTHER_REPO,
    realAuthorization,
    REPO,
    run,
    SECRET,
    SHA,
    storeWith,
    TEAM,
    user, openSealed } from './fixtures';

const owner = user(Role.OWNER);
const repoAdmin = user(Role.REPO_ADMIN);
const contributor = user(Role.CONTRIBUTOR);
const billing = user(Role.BILLING_MANAGER);
const outsider = user(Role.OWNER, { org: OTHER_ORG, uuid: 'outsider' });
const asUser = (u: any): RuntimePrincipal => ({ kind: 'user', user: u });
const key = (patch: Partial<Extract<RuntimePrincipal, { kind: 'team_key' }>> = {}): RuntimePrincipal => ({
    kind: 'team_key',
    keyId: 'k1',
    organizationId: ORG,
    teamId: TEAM,
    capabilities: ['runs:read'],
    repositoryIds: [REPO],
    ...patch,
});

class FakeGit implements RuntimeGitPort {
    head: PullRequestHead | null = { headSha: SHA, baseSha: BASE_SHA, fork: true, authorId: '42', authorLogin: 'forker', state: 'open' };
    identity: GitIdentity | null = { id: '7', login: 'maintainer' };
    canWrite: boolean | undefined | Error = true;
    async getPullRequestHead() {
        return this.head;
    }
    async getPullRequestDiff() {
        return { files: [{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }], truncated: false };
    }
    member: boolean | undefined = undefined;
    async isOrganizationMember() {
        return this.member;
    }
    async resolveGitIdentity() {
        return this.identity;
    }
    async userCanWrite() {
        if (this.canWrite instanceof Error) throw this.canWrite;
        return this.canWrite;
    }
    async getDefaultBranchHead() {
        return { status: 'ok' as const, branch: 'main', sha: BASE_SHA };
    }
    async readFileAtCommit() {
        return null;
    }
}

describe('RuntimeRunAccessService (object-level check)', () => {
    it('answers 404 for a Run of another org, and for an unknown id', async () => {
        const r = run();
        const access = new RuntimeRunAccessService(await storeWith(r), realAuthorization());
        await expect(access.load(asUser(outsider), r.runId)).rejects.toBeInstanceOf(NotFoundException);
        await expect(access.load(asUser(owner), 'missing')).rejects.toBeInstanceOf(NotFoundException);
        await expect(access.load(key({ organizationId: OTHER_ORG }), r.runId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets readers of the org in and keeps billing out (403)', async () => {
        const r = run();
        const access = new RuntimeRunAccessService(await storeWith(r), realAuthorization());
        for (const u of [owner, repoAdmin, contributor]) await expect(access.load(asUser(u), r.runId)).resolves.toMatchObject({ runId: r.runId });
        await expect(access.load(asUser(billing), r.runId)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Create (Run again) is repo-scoped: a repo admin of another repo gets 403', async () => {
        const mine = run();
        const theirs = run({ repositoryId: OTHER_REPO });
        const access = new RuntimeRunAccessService(await storeWith(mine, theirs), realAuthorization([REPO]));
        await expect(access.load(asUser(repoAdmin), mine.runId, Action.Create)).resolves.toBeDefined();
        await expect(access.load(asUser(repoAdmin), theirs.runId, Action.Create)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(access.load(asUser(contributor), mine.runId, Action.Create)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('team key: wrong team is 404, missing capability or repo is 403, never anything but Read', async () => {
        const r = run();
        const access = new RuntimeRunAccessService(await storeWith(r), realAuthorization());
        await expect(access.load(key(), r.runId)).resolves.toMatchObject({ runId: r.runId });
        await expect(access.load(key({ teamId: 'team-b' }), r.runId)).rejects.toBeInstanceOf(NotFoundException);
        await expect(access.load(key({ capabilities: ['config:repo:manage'] }), r.runId)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(access.load(key({ repositoryIds: [OTHER_REPO] }), r.runId)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(access.load(key(), r.runId, Action.Create)).rejects.toBeInstanceOf(ForbiddenException);
    });
});

describe('List and get Runs', () => {
    it('lists only the caller org, filtered by repository, newest first', async () => {
        const a = run({ requestedAt: '2026-10-29T10:00:00.000Z' });
        const b = run({ requestedAt: '2026-10-29T11:00:00.000Z', repositoryId: OTHER_REPO });
        const c = run({ organizationId: OTHER_ORG });
        const list = new ListRuntimeRunsUseCase(await storeWith(a, b, c), realAuthorization(), new RuntimeRunCostService(new InMemoryLlmUsage(), clock));
        expect((await list.execute({ user: owner })).map((r) => r.runId)).toEqual([b.runId, a.runId]);
        expect((await list.execute({ user: owner, repositoryId: REPO })).map((r) => r.runId)).toEqual([a.runId]);
        const [summary] = await list.execute({ user: owner, repositoryId: REPO });
        expect(summary.check).toEqual({ conclusion: 'failure', title: '0 regressions' });
        await expect(list.execute({ user: billing, repositoryId: REPO })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(list.execute({ user: owner, limit: 0 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a repo-scoped user sees their Runs even behind 200 newer Runs of other repos (scope in the query)', async () => {
        const mine = run({ requestedAt: '2026-10-01T00:00:00.000Z' });
        const others = Array.from({ length: 210 }, (_, i) => run({ repositoryId: OTHER_REPO, requestedAt: `2026-10-29T${String(10 + (i % 10)).padStart(2, '0')}:00:00.000Z` }));
        const scoped = { ensure: async () => undefined, getRepositoryScope: async () => [REPO] };
        const list = new ListRuntimeRunsUseCase(await storeWith(mine, ...others), scoped as any, new RuntimeRunCostService(new InMemoryLlmUsage(), clock));
        expect((await list.execute({ user: repoAdmin })).map((r) => r.runId)).toEqual([mine.runId]);
    });

    it('returns the detail with its LLM cost and without the internal correlation id', async () => {
        const r = run({ findings: [] });
        const usage = new InMemoryLlmUsage();
        await usage.record({ runId: r.runId, organizationId: ORG, repositoryId: REPO, prNumber: 7, task: 'runtime.plan', inputTokens: 30, outputTokens: 12, at: NOW });
        const store = await storeWith(r);
        const get = new GetRuntimeRunUseCase(new RuntimeRunAccessService(store, realAuthorization()), new RuntimeRunCostService(usage, clock));
        const detail = await get.execute({ principal: asUser(contributor), runId: r.runId });
        expect(detail.cost).toMatchObject({ estimate: true, llmTokens: 42, llm: { tokens: 42, usd: null } });
        expect(detail).not.toHaveProperty('correlationId');
        await expect(get.execute({ principal: asUser(outsider), runId: r.runId })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('the detail carries the boot failure and each finding\'s response diff and diff link', async () => {
        const bootFailure = { side: 'pr' as const, kind: 'platform' as const, signature: 'platform:go_checksum_db', title: 't', errorLine: 'lookup sum.golang.org: no such host', logTail: ['a'], at: NOW };
        const finding = {
            probeId: 'p1',
            entryPoint: 'GET /branches',
            verdict: 'finding' as const,
            reason: 'differs',
            responseDiff: { fields: [{ path: 'json.branch', base: '"main"', pr: '"feature"' }], truncated: false },
            diffRef: { file: 'src/branches.ts', line: 12 },
        };
        const r = run({ findings: [finding], probes: [finding], bootFailure });
        const get = new GetRuntimeRunUseCase(new RuntimeRunAccessService(await storeWith(r), realAuthorization()), new RuntimeRunCostService(new InMemoryLlmUsage(), clock));
        const detail = await get.execute({ principal: asUser(contributor), runId: r.runId });
        expect(detail.bootFailure).toEqual(bootFailure);
        expect(detail.findings![0]).toMatchObject({ responseDiff: finding.responseDiff, diffRef: finding.diffRef });
        expect(detail.probes![0].diffRef).toEqual(finding.diffRef);
    });

    describe('what reached the PR: the product publication record, never the projection', () => {
        const target = (r: ReturnType<typeof run>, patch: Record<string, unknown> = {}) => ({
            runId: r.runId,
            attempt: r.attempt,
            organizationId: ORG,
            teamId: TEAM,
            repositoryId: REPO,
            repositoryName: 'acme/shop',
            platform: PlatformType.GITHUB,
            pullRequestNumber: 7,
            headSha: SHA,
            ...patch,
        });
        const publication = (r: ReturnType<typeof run>, key: string, patch: Record<string, unknown> = {}) => ({
            key,
            runId: r.runId,
            attempt: r.attempt,
            kind: key.includes(':check') ? ('check' as const) : ('comment' as const),
            organizationId: ORG,
            teamId: TEAM,
            repositoryId: REPO,
            prNumber: 7,
            headSha: SHA,
            status: 'published' as const,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            ...patch,
        });
        async function getWith(r: ReturnType<typeof run>, opts: { target?: Record<string, unknown> | null; rows?: any[] }) {
            const targets = new InMemoryRunTargetStore();
            if (opts.target !== null) await targets.record(target(r, opts.target) as any);
            const publications = new InMemoryPublicationStore();
            for (const row of opts.rows ?? []) publications.rows.set(row.key, row);
            const get = new GetRuntimeRunUseCase(
                new RuntimeRunAccessService(await storeWith(r), realAuthorization()),
                new RuntimeRunCostService(new InMemoryLlmUsage(), clock),
                undefined,
                publications,
                targets,
            );
            return get.execute({ principal: asUser(contributor), runId: r.runId });
        }

        it('the Runtime asking to publish is not "published": the comment that never landed reads pending', async () => {
            const r = run({ state: 'partly_tested', published: ['check', 'comment'], publishStartedAt: NOW.toISOString() });
            const detail = await getWith(r, {
                target: {},
                rows: [
                    publication(r, `${r.runId}:1:check`, { checkRank: 3 }),
                    publication(r, `${r.runId}:1:comment:reporting`),
                    publication(r, `${r.runId}:1:comment`, { status: 'failed' }),
                ],
            });
            expect(detail).not.toHaveProperty('published');
            expect(detail).not.toHaveProperty('publishStartedAt');
            expect(detail.publication).toMatchObject({
                postsToPullRequest: true,
                check: { status: 'published' },
                comment: { status: 'pending', retrying: true, showing: 'reporting' },
                settled: false,
            });
        });

        it('a simulation (no publish target) posts nothing, whatever the projection says', async () => {
            const r = run({ state: 'no_regressions', published: ['check', 'comment'] });
            const detail = await getWith(r, { target: null });
            expect(detail.publication).toEqual({ postsToPullRequest: false, check: { status: 'not_expected' }, comment: { status: 'not_expected' }, settled: true });
        });

        it('rows and targets of another org never count', async () => {
            const r = run({ state: 'no_regressions' });
            const detail = await getWith(r, {
                target: { organizationId: OTHER_ORG },
                rows: [publication(r, `${r.runId}:1:check`, { checkRank: 3, organizationId: OTHER_ORG })],
            });
            expect(detail.publication?.postsToPullRequest).toBe(false);

            const r2 = run({ state: 'no_regressions' });
            const detail2 = await getWith(r2, { target: {}, rows: [publication(r2, `${r2.runId}:1:check`, { checkRank: 3, organizationId: OTHER_ORG })] });
            expect(detail2.publication?.check).toEqual({ status: 'pending' });
        });
    });
});

describe('Run stream', () => {
    const setup = async () => {
        const r = run({ state: 'testing' });
        const streams = new InMemoryRunStreamStore();
        const uc = new ReadRuntimeRunStreamUseCase(new RuntimeRunAccessService(await storeWith(r), realAuthorization()), streams, config());
        return { r, streams, uc };
    };

    it('resumes from the opaque offset without loss or repetition', async () => {
        const { r, streams, uc } = await setup();
        for (let i = 0; i < 3; i++) await streams.append(ORG, r.runId, { type: 'phase', at: `t${i}`, data: { i } });
        const first = await uc.execute({ principal: asUser(owner), runId: r.runId });
        expect(first).toMatchObject({ status: 200, upToDate: true });
        expect(first.events.map((e) => e.data.i)).toEqual([0, 1, 2]);
        await streams.append(ORG, r.runId, { type: 'verdict', at: 't3', data: { i: 3 } });
        const next = await uc.execute({ principal: key(), runId: r.runId, offset: first.nextOffset });
        expect(next.events.map((e) => e.data.i)).toEqual([3]);
    });

    it('serves an empty, up-to-date stream from the start before the hub writes', async () => {
        const { r, uc } = await setup();
        await expect(uc.execute({ principal: asUser(owner), runId: r.runId, offset: 'stale' })).resolves.toEqual({
            status: 200,
            events: [],
            nextOffset: '-1',
            upToDate: true,
        });
    });

    it('rejects a forged offset on an existing stream with 400', async () => {
        const { r, streams, uc } = await setup();
        await streams.append(ORG, r.runId, { type: 'state', at: 't', data: {} });
        await expect(uc.execute({ principal: asUser(owner), runId: r.runId, offset: 'garbage' })).rejects.toBeInstanceOf(BadRequestException);
        await expect(uc.execute({ principal: asUser(owner), runId: r.runId, live: 'sse' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('long-poll returns as soon as an event lands, and 204 when the wait times out', async () => {
        const { r, streams, uc } = await setup();
        const start = await uc.execute({ principal: asUser(owner), runId: r.runId });
        setTimeout(() => void streams.append(ORG, r.runId, { type: 'state', at: 't', data: { state: 'testing' } }), 50);
        const woke = await uc.execute({ principal: asUser(owner), runId: r.runId, offset: start.nextOffset, live: 'long-poll' });
        expect(woke.status).toBe(200);
        expect(woke.events).toHaveLength(1);
        const timedOut = await uc.execute({ principal: asUser(owner), runId: r.runId, offset: woke.nextOffset, live: 'long-poll' });
        expect(timedOut).toMatchObject({ status: 204, events: [], upToDate: true, nextOffset: woke.nextOffset });
    });

    it('applies the object check before reading: another org is 404, a key without the repo is 403', async () => {
        const { r, uc } = await setup();
        await expect(uc.execute({ principal: asUser(outsider), runId: r.runId })).rejects.toBeInstanceOf(NotFoundException);
        await expect(uc.execute({ principal: key({ repositoryIds: [] }), runId: r.runId })).rejects.toBeInstanceOf(ForbiddenException);
    });
});

describe('Evidence URL', () => {
    const STEP = '6f1c2b0e-4d3a-4b5c-9d8e-7f6a5b4c3d2e';
    it('signs the key of the authorized Run only', async () => {
        const r = run();
        const access = new RuntimeRunAccessService(await storeWith(r), realAuthorization());
        const uc = new GetRuntimeRunEvidenceUseCase(access, config(), clock);
        const res = await uc.execute({ user: contributor, runId: r.runId, stepId: STEP, side: 'base', type: 'screenshot' });
        expect(res.key).toBe(`${ORG}/${r.runId}/base/${STEP}/screenshot`);
        expect(Date.parse(res.expiresAt) - NOW.getTime()).toBeLessThanOrEqual(300_000);
        await expect(uc.execute({ user: outsider, runId: r.runId, stepId: STEP })).rejects.toBeInstanceOf(NotFoundException);
        await expect(uc.execute({ user: owner, runId: r.runId, stepId: '../x' })).rejects.toBeInstanceOf(BadRequestException);
        const unconfigured = new GetRuntimeRunEvidenceUseCase(access, config({ evidenceBaseUrl: undefined }), clock);
        await expect(unconfigured.execute({ user: owner, runId: r.runId, stepId: STEP })).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('with the S3 store, presigns a GET of that key in the bucket, at most 5 minutes', async () => {
        const r = run();
        const access = new RuntimeRunAccessService(await storeWith(r), realAuthorization());
        const evidenceS3 = loadS3EvidenceConfig({
            RUNTIME_EVIDENCE_S3_BUCKET: 'kodus-evidence',
            RUNTIME_EVIDENCE_S3_ACCESS_KEY_ID: 'AKIDREADONLY',
            RUNTIME_EVIDENCE_S3_SECRET_ACCESS_KEY: 'read-only-secret-0000000000',
            RUNTIME_EVIDENCE_S3_PREFIX: 'evidence',
        });
        const uc = new GetRuntimeRunEvidenceUseCase(access, config({ evidenceStore: 's3', evidenceS3, evidenceBaseUrl: undefined, evidenceSigningSecret: undefined }), clock);
        const res = await uc.execute({ user: contributor, runId: r.runId, stepId: STEP, side: 'pr', type: 'output' });
        const u = new URL(res.url);
        expect(u.origin).toBe('https://kodus-evidence.s3.us-east-1.amazonaws.com');
        expect(u.pathname).toBe(`/evidence/${ORG}/${r.runId}/pr/${STEP}/output`);
        expect(u.searchParams.get('response-content-disposition')).toMatch(/^attachment; /);
        expect(Date.parse(res.expiresAt) - NOW.getTime()).toBeLessThanOrEqual(300_000);
        await expect(uc.execute({ user: outsider, runId: r.runId, stepId: STEP })).rejects.toBeInstanceOf(NotFoundException);
        const missing = new GetRuntimeRunEvidenceUseCase(access, config({ evidenceStore: 's3' }), clock);
        await expect(missing.execute({ user: owner, runId: r.runId, stepId: STEP })).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
});

describe('Run again', () => {
    const setup = async (...runs: ReturnType<typeof run>[]) => {
        const store = await storeWith(...runs);
        const git = new FakeGit();
        const outbox = new FakeOutbox();
        const targets = new InMemoryRunTargetStore();
        // The product stored the target of each earlier Run when it enqueued it.
        for (const r of runs) {
            await targets.record({
                runId: r.runId,
                attempt: r.attempt,
                organizationId: r.organizationId,
                teamId: r.teamId,
                repositoryId: r.repositoryId,
                repositoryName: r.repositoryName,
                platform: PlatformType.GITHUB,
                pullRequestNumber: r.prNumber,
                headSha: r.headSha,
            });
        }
        const order: string[] = [];
        const recordTarget = targets.record.bind(targets);
        targets.record = async (t) => {
            order.push('target');
            await recordTarget(t);
        };
        const create = outbox.create.bind(outbox);
        outbox.create = async (row: any) => {
            order.push('outbox');
            await create(row);
        };
        const repoTokens = { issue: jest.fn(async (_input: any) => 'repo-token') };
        const enqueuer = new RuntimeRunEnqueuer(targets, outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
        const builder = new RuntimeRunRequestBuilder(
            git,
            repoTokens,
            { get: async () => ({ environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, imageId: 'img-2' }) },
            config(),
            clock,
        );
        const uc = new RunRuntimeAgainUseCase(new RuntimeRunAccessService(store, realAuthorization()), store, git, builder, enqueuer, config());
        return { store, git, outbox, targets, order, repoTokens, uc };
    };

    it('stores the publish target in the product before the outbox row, and asks the token for the stored repo', async () => {
        const prev = run();
        const s = await setup(prev);
        const res = await s.uc.execute({ user: owner, runId: prev.runId });
        expect(s.order).toEqual(['target', 'outbox']);
        const request = s.outbox.rows[0].payload.payload;
        expect(await s.targets.get(res.runId)).toEqual(runTargetOf(request, PlatformType.GITHUB));
        expect(await s.targets.get(res.runId)).toMatchObject({ organizationId: ORG, repositoryId: REPO, pullRequestNumber: 7, headSha: SHA, attempt: 2 });
        expect(s.repoTokens.issue).toHaveBeenCalledWith({ organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' });
        // One token per side: each claim revokes the token it fetched with.
        expect(s.repoTokens.issue).toHaveBeenCalledTimes(2);
    });

    it('answers 503 and enqueues nothing while the platform has no download token', async () => {
        const prev = run();
        const s = await setup(prev);
        s.repoTokens.issue.mockRejectedValueOnce(new ServiceUnavailableException('not for GITLAB yet'));
        await expect(s.uc.execute({ user: owner, runId: prev.runId })).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(s.outbox.rows).toHaveLength(0);
        expect(s.targets.rows.size).toBe(1);
    });

    it('refuses a previous Run without a product target, or whose projection disagrees with it', async () => {
        const prev = run();
        const s = await setup(prev);
        s.targets.rows.delete(prev.runId);
        await expect(s.uc.execute({ user: owner, runId: prev.runId })).rejects.toThrow('no target recorded');

        const moved = run();
        const m = await setup(moved);
        await m.store.upsert(moved.runId, { repositoryId: REPO, prNumber: 99 });
        await expect(m.uc.execute({ user: owner, runId: moved.runId })).rejects.toThrow('does not match');
        expect(m.outbox.rows).toHaveLength(0);
    });

    it('enqueues a new runId with attempt + 1 and a Run token signed by the product', async () => {
        const prev = run({ attempt: 2 });
        const { outbox, uc } = await setup(prev, run({ attempt: 1, state: 'errored' }));
        const res = await uc.execute({ user: repoAdmin, runId: prev.runId });
        expect(res).toMatchObject({ attempt: 3, state: 'queued' });
        expect(res.runId).not.toBe(prev.runId);
        expect(outbox.events).toEqual(['runtime.run.requested']);
        const payload = outbox.rows[0].payload.payload;
        const { workflowType: _w, ...request } = payload;
        expect(RuntimeRunRequestedSchema.parse(request)).toMatchObject({ trigger: 'run_again', attempt: 3 });
        // Both tokens travel sealed to this Run; the worker opens them with the same key.
        expect(JSON.stringify(outbox.rows)).not.toContain('repo-token');
        expect(openSealed(request.repoToken, res.runId)).toBe('repo-token');
        expect(() => openSealed(request.repoToken, prev.runId)).toThrow();
        expect(request.environment.imageId).toBe('img-2');
        expect(verifyRunToken(openSealed(request.runToken, res.runId), SECRET, NOW)).toMatchObject({ runId: res.runId, attempt: 3, organizationId: ORG, prNumber: 7 });
    });

    it('two clicks on "Run again" make one Run: the runId is derived from the previous Run and the attempt', async () => {
        const prev = run();
        const s = await setup(prev);
        const a = await s.uc.execute({ user: owner, runId: prev.runId });
        const b = await s.uc.execute({ user: owner, runId: prev.runId });
        expect(a.runId).toBe(b.runId);
    });

    it('refuses to enqueue without RUNTIME_SECRET_SEAL_KEY: no plain token reaches the outbox', async () => {
        const prev = run();
        const s = await setup(prev);
        const builder = new RuntimeRunRequestBuilder(s.git, s.repoTokens, { get: async () => ({ environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, imageId: 'img-2' }) }, config({ secretSealKey: undefined }), clock);
        const enqueuer = new RuntimeRunEnqueuer(s.targets, s.outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
        const uc = new RunRuntimeAgainUseCase(new RuntimeRunAccessService(s.store, realAuthorization()), s.store, s.git, builder, enqueuer, config());
        await expect(uc.execute({ user: owner, runId: prev.runId })).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(s.outbox.rows).toHaveLength(0);
    });

    it('refuses while the previous Run is live, when another Run of that SHA is live, or the head moved', async () => {
        const live = run({ state: 'testing' });
        await expect((await setup(live)).uc.execute({ user: owner, runId: live.runId })).rejects.toBeInstanceOf(ConflictException);

        const done = run();
        const other = run({ state: 'queued' });
        await expect((await setup(done, other)).uc.execute({ user: owner, runId: done.runId })).rejects.toThrow('still running');

        const s = await setup(done);
        s.git.head = { ...s.git.head!, headSha: 'c'.repeat(40) };
        await expect(s.uc.execute({ user: owner, runId: done.runId })).rejects.toThrow('newer head');
        expect(s.outbox.rows).toHaveLength(0);
    });

    it('is a repo setting: contributor 403, repo admin of another repo 403, another org 404', async () => {
        const other = run({ repositoryId: OTHER_REPO });
        const s = await setup(other);
        await expect(s.uc.execute({ user: contributor, runId: other.runId })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(s.uc.execute({ user: repoAdmin, runId: other.runId })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(s.uc.execute({ user: outsider, runId: other.runId })).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('Fork approval', () => {
    const setup = async (patch = {}) => {
        const r = run({ state: 'awaiting_approval', ...patch });
        const git = new FakeGit();
        const outbox = new FakeOutbox();
        const issued: unknown[] = [];
        const builder = new RuntimeRunRequestBuilder(
            git as any,
            { issue: async (i: unknown) => (issued.push(i), 'fresh-repo-token') },
            { get: async () => null },
            config({ runTokenSecret: SECRET }),
            clock,
        );
        const uc = new ApproveForkRunUseCase(new RuntimeRunAccessService(await storeWith(r), realAuthorization()), git, outbox as any, clock, builder);
        return { r, git, outbox, uc, issued };
    };

    it('approving is a write: a contributor who can only read the Run is refused', async () => {
        const { r, outbox, uc, issued } = await setup();
        await expect(uc.execute({ user: contributor, runId: r.runId })).rejects.toBeInstanceOf(ForbiddenException);
        expect(outbox.rows).toHaveLength(0);
        expect(issued).toHaveLength(0);
    });

    it('carries fresh tokens sealed for the Run, the Run token on the fork budget', async () => {
        const { r, outbox, uc, issued } = await setup();
        await uc.execute({ user: repoAdmin, runId: r.runId });
        const { workflowType: _t, ...body } = outbox.rows[0].payload.payload;
        const sent = RuntimeForkApprovedSchema.parse(body);
        // One download token per side: each claim revokes the token it fetched with.
        const repo = { organizationId: r.organizationId, teamId: r.teamId, repositoryId: r.repositoryId, repositoryName: r.repositoryName };
        expect(issued).toEqual([repo, repo]);
        expect(openSealed(sent.tokens!.repoToken, r.runId)).toBe('fresh-repo-token');
        expect(openSealed(sent.tokens!.prRepoToken!, r.runId)).toBe('fresh-repo-token');
        const claims = verifyRunToken(openSealed(sent.tokens!.runToken, r.runId), SECRET, NOW);
        expect(claims).toMatchObject({ runId: r.runId, maxTokens: Math.floor(config().llmBudget.perRun / 4) });
    });

    it('a refused approver gets no tokens minted', async () => {
        const s = await setup();
        s.git.canWrite = false;
        await expect(s.uc.execute({ user: owner, runId: s.r.runId })).rejects.toBeInstanceOf(ForbiddenException);
        expect(s.issued).toHaveLength(0);
    });

    it('records the approver and the head SHA when the Git API confirms write', async () => {
        const { r, outbox, uc } = await setup();
        await expect(uc.execute({ user: repoAdmin, runId: r.runId })).resolves.toMatchObject({ headSha: SHA });
        expect(outbox.events).toEqual(['runtime.run.fork_approved']);
        expect(outbox.rows[0].payload.payload).toMatchObject({
            runId: r.runId,
            headSha: SHA,
            key: `${r.runId}:${SHA}`,
            approver: { userId: repoAdmin.uuid, gitUserId: '7', gitLogin: 'maintainer' },
        });
    });

    it('refuses the PR author, by id or by login', async () => {
        const s = await setup();
        s.git.identity = { id: '42' };
        await expect(s.uc.execute({ user: owner, runId: s.r.runId })).rejects.toThrow('author');
        s.git.identity = { login: 'FORKER' };
        await expect(s.uc.execute({ user: owner, runId: s.r.runId })).rejects.toThrow('author');
        expect(s.outbox.rows).toHaveLength(0);
    });

    it('denies without confirmed write: false, undefined or an error from the Git API', async () => {
        for (const canWrite of [false, undefined, new Error('rate limited')]) {
            const s = await setup();
            s.git.canWrite = canWrite;
            await expect(s.uc.execute({ user: owner, runId: s.r.runId })).rejects.toBeInstanceOf(ForbiddenException);
            expect(s.outbox.rows).toHaveLength(0);
        }
        const s = await setup();
        s.git.identity = null;
        await expect(s.uc.execute({ user: owner, runId: s.r.runId })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('binds to the head: a new push asks again, and only awaiting Runs can be approved', async () => {
        const moved = await setup();
        moved.git.head = { ...moved.git.head!, headSha: 'd'.repeat(40) };
        await expect(moved.uc.execute({ user: owner, runId: moved.r.runId })).rejects.toBeInstanceOf(ConflictException);
        const running = await setup({ state: 'testing' });
        await expect(running.uc.execute({ user: owner, runId: running.r.runId })).rejects.toBeInstanceOf(ConflictException);
        const foreign = await setup();
        await expect(foreign.uc.execute({ user: outsider, runId: foreign.r.runId })).rejects.toBeInstanceOf(NotFoundException);
    });
});
