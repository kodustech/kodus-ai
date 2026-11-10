import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { publishKey, type RuntimePublishRequested } from '@libs/runtime/run';

import { InMemoryCommentSlotStore } from '../domain/pull-request-comment-slot';
import { MAX_REDRIVE_ATTEMPTS, REDRIVE_AFTER_MS } from '../domain/publication-redrive';
import { InMemoryRunTargetStore } from '../domain/run-target';
import { InMemoryPublicationStore, type RuntimePublication } from '../domain/runtime-publication';
import type { CodeManagementPort, RedriveMeasurement } from '../domain/runtime-publish.ports';
import { toPublishRepository } from '../infrastructure/integration-config-repository.resolver';
import { PublishRuntimeRequestUseCase, type PublishOutcome } from './publish-runtime-request.use-case';
import { RedriveRuntimePublicationsUseCase } from './redrive-runtime-publications.use-case';

const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@libs/core/log/logger', () => ({ createLogger: () => logger }));

const RUN_ID = '0b9f4c1e-8d2a-4f6b-9a3c-1e2d3f4a5b6c';
const HEAD = 'a'.repeat(40);
const REQUESTED = '2026-10-31T14:00:00.000Z';
const T0 = new Date('2026-10-31T14:30:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const PR = { organizationId: 'org-a', teamId: 'team-a', repositoryId: 'repo-1', prNumber: 42 };

const finalComment = (): RuntimePublishRequested => ({
    runId: RUN_ID,
    attempt: 1,
    kind: 'comment',
    key: publishKey(RUN_ID, 1, 'comment'),
    correlationId: 'corr-1',
    report: {
        state: 'partly_tested',
        verdictState: 'partly_tested',
        headSha: HEAD,
        requestedAt: REQUESTED,
        paths: [{ entryPoint: 'GET /api/health', probeId: 'health', verdict: 'pre_existing', base: { status: 200 }, pr: { status: 200 } }],
        uncovered: [{ entryPoint: 'unmapped:pkg/cmd/grafana/main.go', reason: 'no_probe' }],
        blockedOutbound: [],
    },
});

const finalCheck = (): RuntimePublishRequested => ({
    runId: RUN_ID,
    attempt: 1,
    kind: 'check',
    key: publishKey(RUN_ID, 1, 'check'),
    correlationId: 'corr-1',
    check: { status: 'completed', conclusion: 'neutral', title: 'x', summary: 'x' },
    report: finalComment().report,
});

function staleRow(patch: Partial<RuntimePublication> = {}): RuntimePublication {
    const request = 'request' in patch ? patch.request : finalComment();
    return {
        key: request?.key ?? finalComment().key,
        runId: RUN_ID,
        attempt: 1,
        kind: request?.kind ?? 'comment',
        ...PR,
        headSha: HEAD,
        status: 'failed',
        reason: 'publication is being published by another delivery',
        request,
        createdAt: T0.toISOString(),
        updatedAt: T0.toISOString(),
        ...patch,
    };
}

/** The sweeper over a scripted publish use case. */
function withFakePublish(outcome: () => Promise<PublishOutcome>) {
    const publications = new InMemoryPublicationStore();
    const execute = jest.fn(outcome);
    const measurements: RedriveMeasurement[] = [];
    const stuck: number[] = [];
    const sweeper = new RedriveRuntimePublicationsUseCase(publications, { execute } as unknown as PublishRuntimeRequestUseCase, {
        recordRedrive: (m) => measurements.push(m),
        recordStuck: (n) => stuck.push(n),
    });
    return { publications, execute, sweeper, measurements, stuck };
}

/** The sweeper over the real publish use case, on in-memory stores. */
async function withRealPublish() {
    const targets = new InMemoryRunTargetStore();
    await targets.record({
        runId: RUN_ID,
        attempt: 1,
        organizationId: 'org-a',
        teamId: 'team-a',
        repositoryId: 'repo-1',
        repositoryName: 'widgets',
        repositoryFullName: 'acme/widgets',
        platform: PlatformType.GITHUB,
        pullRequestNumber: 42,
        headSha: HEAD,
    });
    const publications = new InMemoryPublicationStore();
    const slots = new InMemoryCommentSlotStore();
    const codeManagement: jest.Mocked<CodeManagementPort> = {
        getTypeIntegration: jest.fn().mockResolvedValue(PlatformType.GITHUB),
        createIssueComment: jest.fn().mockResolvedValue({ id: 1001 }),
        updateIssueComment: jest.fn().mockResolvedValue(undefined),
        getAllCommentsInPullRequest: jest.fn().mockResolvedValue([]),
        createResponseToComment: jest.fn().mockResolvedValue({ id: 2002 }),
    };
    const publish = new PublishRuntimeRequestUseCase(
        targets,
        publications,
        slots,
        { resolve: async () => toPublishRepository({ id: 'repo-1', name: 'widgets', full_name: 'acme/widgets' }) },
        codeManagement,
        { getAdapter: jest.fn() },
        undefined,
        'https://app.kodus.test',
        undefined,
        { maxWaitMs: 0 },
    );
    const sweeper = new RedriveRuntimePublicationsUseCase(publications, publish);
    return { publications, slots, codeManagement, publish, sweeper };
}

beforeEach(() => jest.clearAllMocks());

describe('RedriveRuntimePublicationsUseCase', () => {
    it('leaves a row alone until it is stale', async () => {
        const t = withFakePublish(async () => ({ outcome: 'published', key: 'k', action: 'updated' }));
        t.publications.rows.set(finalComment().key, staleRow());

        expect(await t.sweeper.sweep(later(REDRIVE_AFTER_MS - 1))).toEqual({ stuck: 0, redriven: 0, recovered: 0, gaveUp: 0 });
        expect(t.execute).not.toHaveBeenCalled();
        expect(t.stuck).toEqual([0]);
    });

    it('publishes the stored request again once stale, and counts the attempt', async () => {
        const t = withFakePublish(async () => ({ outcome: 'published', key: 'k', action: 'updated' }));
        t.publications.rows.set(finalComment().key, staleRow());

        expect(await t.sweeper.sweep(later(REDRIVE_AFTER_MS))).toEqual({ stuck: 1, redriven: 1, recovered: 1, gaveUp: 0 });
        expect(t.execute).toHaveBeenCalledWith(finalComment(), { fallback: false });
        expect(t.publications.rows.get(finalComment().key)?.redrive?.attempts).toBe(1);
        expect(t.measurements).toEqual([{ kind: 'comment', step: 'redrive', outcome: 'recovered' }]);
    });

    it('takes over a delivery whose worker died (expired lease), not a live one', async () => {
        const t = withFakePublish(async () => ({ outcome: 'published', key: 'k', action: 'updated' }));
        const now = later(REDRIVE_AFTER_MS);
        t.publications.rows.set('live', staleRow({ key: 'live', status: 'publishing', leaseUntil: later(REDRIVE_AFTER_MS + 1).toISOString() }));
        t.publications.rows.set('dead', staleRow({ key: 'dead', status: 'publishing', leaseUntil: now.toISOString() }));

        await t.sweeper.sweep(now);
        expect(t.execute).toHaveBeenCalledTimes(1);
        expect(t.publications.rows.get('dead')?.redrive?.attempts).toBe(1);
        expect(t.publications.rows.get('live')?.redrive).toBeUndefined();
    });

    it('never drives a row without a stored request, a published row or one given up', async () => {
        const t = withFakePublish(async () => ({ outcome: 'published', key: 'k', action: 'updated' }));
        t.publications.rows.set('a', staleRow({ key: 'a', request: undefined }));
        t.publications.rows.set('b', staleRow({ key: 'b', status: 'published' }));
        t.publications.rows.set('c', staleRow({ key: 'c', redrive: { attempts: 6, gaveUpAt: T0.toISOString() } }));

        await t.sweeper.sweep(later(REDRIVE_AFTER_MS));
        expect(t.execute).not.toHaveBeenCalled();
    });

    it('a row another replica reserved first is skipped', async () => {
        const t = withFakePublish(async () => ({ outcome: 'published', key: 'k', action: 'updated' }));
        t.publications.rows.set(finalComment().key, staleRow());
        const stale = await t.publications.findStale(later(REDRIVE_AFTER_MS).toISOString(), later(REDRIVE_AFTER_MS).toISOString(), 10);
        await t.publications.reserveRedrive(stale[0].key, stale[0].updatedAt, later(1).toISOString());

        // The scan saw the old updatedAt: the reservation answers null, nothing is published twice.
        expect(await t.publications.reserveRedrive(stale[0].key, stale[0].updatedAt, later(2).toISOString())).toBeNull();
    });

    it('a redrive that fails again waits for the next sweep', async () => {
        const t = withFakePublish(async () => {
            throw new Error('platform down');
        });
        t.publications.rows.set(finalComment().key, staleRow());

        expect(await t.sweeper.sweep(later(REDRIVE_AFTER_MS))).toMatchObject({ redriven: 1, recovered: 0 });
        expect(t.measurements).toEqual([{ kind: 'comment', step: 'redrive', outcome: 'retry_later' }]);
        // The reservation moved updatedAt: the very next tick does not hammer the platform.
        expect(await t.sweeper.sweep(later(REDRIVE_AFTER_MS + 60_000))).toMatchObject({ stuck: 0 });
    });

    it('after the last attempt, a report comment gets the short fallback once, then the sweeper gives up', async () => {
        const t = withFakePublish(async () => {
            throw new Error('platform refuses the body');
        });
        t.publications.rows.set(finalComment().key, staleRow({ redrive: { attempts: MAX_REDRIVE_ATTEMPTS } }));

        await t.sweeper.sweep(later(REDRIVE_AFTER_MS));
        expect(t.execute).toHaveBeenCalledWith(finalComment(), { fallback: true });

        const row = t.publications.rows.get(finalComment().key)!;
        await t.sweeper.sweep(new Date(Date.parse(row.updatedAt) + REDRIVE_AFTER_MS));
        expect(t.publications.rows.get(finalComment().key)).toMatchObject({
            status: 'failed',
            redrive: { attempts: MAX_REDRIVE_ATTEMPTS + 1, gaveUpReason: 'attempts' },
        });
        expect(t.measurements.at(-1)).toEqual({ kind: 'comment', step: 'give_up', outcome: 'gave_up' });
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ alert: 'runtime_publish_given_up' }) }));
    });

    it('after the last attempt, a completed check is closed neutral once (the fallback), then the sweeper gives up', async () => {
        const t = withFakePublish(async () => ({ outcome: 'published', key: 'k', action: 'updated' }));
        t.publications.rows.set(finalCheck().key, staleRow({ request: finalCheck(), kind: 'check', key: finalCheck().key, redrive: { attempts: MAX_REDRIVE_ATTEMPTS } }));

        expect(await t.sweeper.sweep(later(REDRIVE_AFTER_MS))).toMatchObject({ recovered: 1 });
        expect(t.execute).toHaveBeenCalledWith(finalCheck(), { fallback: true });
        expect(t.measurements.at(-1)).toEqual({ kind: 'check', step: 'fallback', outcome: 'recovered' });
    });

    it('a refusal cannot change by retrying: it gives up at once', async () => {
        const t = withFakePublish(async () => ({ outcome: 'refused', reason: 'repository_not_in_org' }));
        t.publications.rows.set(finalComment().key, staleRow());

        expect(await t.sweeper.sweep(later(REDRIVE_AFTER_MS))).toMatchObject({ gaveUp: 1 });
        expect(t.publications.rows.get(finalComment().key)?.redrive?.gaveUpReason).toBe('refused:repository_not_in_org');
    });

    it('kr-grafana#3: the report that lost the slot to the last progress lands on the next sweeps', async () => {
        const t = await withRealPublish();
        await t.publish.execute({ ...finalComment(), key: publishKey(RUN_ID, 1, 'comment', 'reporting'), report: undefined, progress: { phase: 'reporting', requestedAt: REQUESTED, startedAt: REQUESTED } });
        // The progress edit still holds the PR's slot when the report arrives: the delivery fails and the broker retry is lost.
        await t.slots.acquire(PR, 'progress-edit');
        await expect(t.publish.execute(finalComment())).rejects.toThrow('being published by another delivery');
        await t.slots.release(PR, 'progress-edit');
        const failed = t.publications.rows.get(finalComment().key)!;
        expect(failed).toMatchObject({ status: 'failed', request: finalComment() });

        const out = await t.sweeper.sweep(new Date(Date.parse(failed.updatedAt) + REDRIVE_AFTER_MS));
        expect(out).toMatchObject({ recovered: 1 });
        expect(t.publications.rows.get(finalComment().key)).toMatchObject({ status: 'published', redrive: { attempts: 1 } });
        // Edited in place: still one comment on the PR, now with the report.
        expect(t.codeManagement.createIssueComment).toHaveBeenCalledTimes(1);
        expect(t.codeManagement.updateIssueComment.mock.calls.at(-1)?.[0].body).toContain('### Kody Runtime · Partly tested');
    });
});
