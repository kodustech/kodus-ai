import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    CheckConclusion,
    CheckStatus,
    type IChecksAdapter,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import {
    publishKey,
    RuntimeEventName,
    runtimeEnvelope,
    type CommentPhase,
    type RuntimePublishRequested,
    type RuntimeRunReport,
} from '@libs/runtime/run';

import { InMemoryCommentSlotStore } from '../domain/pull-request-comment-slot';
import { RUNTIME_COMMENT_MARKER } from '../domain/render-runtime-comment';
import { InMemoryRunTargetStore, type RunTarget } from '../domain/run-target';
import { InMemoryPublicationStore } from '../domain/runtime-publication';
import type {
    CodeManagementPort,
    PublishMeasurement,
    PublishRepository,
} from '../domain/runtime-publish.ports';
import { toPublishRepository } from '../infrastructure/integration-config-repository.resolver';
import {
    MAX_CHECK_CREATE_ATTEMPTS,
    PublicationBusyError,
    PublicationFailedError,
    PublishRuntimeRequestUseCase,
    recoveredCommentRef,
    unwrapPublishMessage,
} from './publish-runtime-request.use-case';

const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@libs/core/log/logger', () => ({ createLogger: () => logger }));

const RUN_ID = '0b9f4c1e-8d2a-4f6b-9a3c-1e2d3f4a5b6c';
const HEAD = 'a'.repeat(40);
const REQUESTED = '2026-10-31T14:00:00.000Z';
const DASHBOARD = 'https://app.kodus.test';

function record(overrides: Partial<RunTarget> = {}): RunTarget {
    return {
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
        ...overrides,
    };
}

function report(patch: Partial<RuntimeRunReport> = {}): RuntimeRunReport {
    return {
        state: 'no_regressions',
        verdictState: 'no_regressions',
        headSha: HEAD,
        requestedAt: REQUESTED,
        paths: [
            {
                entryPoint: 'GET /orders',
                probeId: 'list',
                verdict: 'not_reproduced',
                base: { status: 200 },
                pr: { status: 200 },
            },
        ],
        uncovered: [],
        blockedOutbound: [],
        ...patch,
    };
}

const result = (overrides: Partial<RuntimePublishRequested> = {}): RuntimePublishRequested => ({
    runId: RUN_ID,
    attempt: 1,
    kind: 'comment',
    key: publishKey(RUN_ID, 1, 'comment'),
    correlationId: 'corr-1',
    report: report(),
    ...overrides,
});

const progress = (phase: CommentPhase, requestedAt = REQUESTED): RuntimePublishRequested => ({
    runId: RUN_ID,
    attempt: 1,
    kind: 'comment',
    key: publishKey(RUN_ID, 1, 'comment', phase),
    correlationId: 'corr-1',
    progress: { phase, requestedAt, startedAt: requestedAt },
});

const finalCheck = (overrides: Partial<RuntimePublishRequested> = {}): RuntimePublishRequested => ({
    runId: RUN_ID,
    attempt: 1,
    kind: 'check',
    key: publishKey(RUN_ID, 1, 'check'),
    correlationId: 'corr-1',
    check: { status: 'completed', conclusion: 'success', title: 'ignored', summary: 'ignored' },
    report: report(),
    ...overrides,
});

const awaitingCheck = (): RuntimePublishRequested => ({
    runId: RUN_ID,
    attempt: 1,
    kind: 'check',
    key: publishKey(RUN_ID, 1, 'check', 'awaiting_approval'),
    correlationId: 'corr-1',
    check: { status: 'completed', conclusion: 'action_required', title: '[click](https://evil.test)', summary: '@everyone' },
});

const onTheWire = (msg: unknown) =>
    runtimeEnvelope(RuntimeEventName.PublishRequested, { ...(msg as object), workflowType: WorkflowType.RUNTIME_PUBLISH }, 'msg-1');

const REPOS: Record<string, PublishRepository> = {
    'org-a/team-a/repo-1': toPublishRepository({ id: 'repo-1', name: 'widgets', full_name: 'acme/widgets' }),
};

async function setup(opts: { platform?: PlatformType; target?: Partial<RunTarget> | null; slotWait?: { maxWaitMs: number; sleep?: (ms: number) => Promise<void> } } = {}) {
    const platform = opts.platform ?? PlatformType.GITHUB;
    const targets = new InMemoryRunTargetStore();
    if (opts.target !== null) await targets.record(record({ platform, ...opts.target }));
    const publications = new InMemoryPublicationStore();
    const slots = new InMemoryCommentSlotStore();
    const repositories = {
        resolve: jest.fn(async (o: { organizationId?: string; teamId?: string }, id: string) => REPOS[`${o.organizationId}/${o.teamId}/${id}`] ?? null),
    };
    let nextId = 1000;
    const codeManagement: jest.Mocked<CodeManagementPort> = {
        getTypeIntegration: jest.fn().mockResolvedValue(platform),
        createIssueComment: jest.fn().mockImplementation(async () => ({ id: ++nextId })),
        updateIssueComment: jest.fn().mockResolvedValue(undefined),
        getAllCommentsInPullRequest: jest.fn().mockResolvedValue([]),
        createResponseToComment: jest.fn().mockResolvedValue({ id: 2002 }),
    };
    const adapter: jest.Mocked<IChecksAdapter> = {
        findCheckRun: jest.fn().mockResolvedValue(null),
        createCheckRun: jest.fn().mockResolvedValue(555),
        updateCheckRun: jest.fn().mockResolvedValue(true),
    };
    const measurements: PublishMeasurement[] = [];
    const useCase = new PublishRuntimeRequestUseCase(
        targets,
        publications,
        slots,
        repositories,
        codeManagement,
        { getAdapter: jest.fn().mockReturnValue(adapter) },
        undefined,
        DASHBOARD,
        { record: (m) => measurements.push(m) },
        opts.slotWait ?? { maxWaitMs: 0 },
    );
    return { targets, publications, slots, repositories, codeManagement, adapter, useCase, measurements };
}

const PR = { organizationId: 'org-a', teamId: 'team-a', repositoryId: 'repo-1', prNumber: 42 };
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

beforeEach(() => jest.clearAllMocks());

describe('PublishRuntimeRequestUseCase', () => {
    describe('target: only the product-stored record', () => {
        it('publishes on the PR of the record, with the rendered and marked body', async () => {
            const t = await setup();
            const out = await t.useCase.execute(onTheWire(result()));

            expect(out).toEqual({ outcome: 'published', key: `${RUN_ID}:1:comment`, action: 'created' });
            const [params, platform] = t.codeManagement.createIssueComment.mock.calls[0];
            expect(platform).toBe(PlatformType.GITHUB);
            expect(params).toMatchObject({
                organizationAndTeamData: { organizationId: 'org-a', teamId: 'team-a' },
                repository: { id: 'repo-1', name: 'widgets' },
                prNumber: 42,
            });
            expect(params.body.startsWith('### Kody Runtime · No regressions')).toBe(true);
            expect(params.body.endsWith(RUNTIME_COMMENT_MARKER)).toBe(true);
        });

        it('refuses a message that carries its own target', async () => {
            const t = await setup();
            const out = await t.useCase.execute(onTheWire({ ...result(), organizationId: 'org-b', prNumber: 7 }));
            expect(out).toMatchObject({ outcome: 'refused', reason: 'invalid_message' });
            expect(t.codeManagement.createIssueComment).not.toHaveBeenCalled();
        });

        it.each([
            ['an unknown runId', { target: null }, 'target_not_found'],
            ['another attempt', { target: { attempt: 2 } }, 'attempt_mismatch'],
            ['a repo the org and team do not own', { target: { teamId: 'team-z' } }, 'repository_not_in_org'],
            ['a repo name that is not the configured one', { target: { repositoryName: 'other', repositoryFullName: 'x/other' } }, 'repository_mismatch'],
            ['a platform that is not the stored one', { target: { platform: PlatformType.GITLAB } }, 'platform_mismatch'],
        ] as const)('refuses %s', async (_what, opts, reason) => {
            const t = await setup(opts as never);
            expect(await t.useCase.execute(onTheWire(result()))).toMatchObject({ outcome: 'refused', reason });
            expect(t.codeManagement.createIssueComment).not.toHaveBeenCalled();
            expect(t.publications.rows.size).toBe(0);
        });

        it('refuses a key that is not the one of its kind, and another event on the queue', async () => {
            const t = await setup();
            expect(await t.useCase.execute(onTheWire(result({ key: `${RUN_ID}:1:check` })))).toMatchObject({ reason: 'key_mismatch' });
            expect(unwrapPublishMessage({ event_name: 'other', payload: {} })).toEqual({ ok: false, reason: 'unexpected_event' });
            expect(unwrapPublishMessage({ ...result(), workflowType: WorkflowType.CODE_REVIEW })).toEqual({ ok: false, reason: 'unexpected_event' });
        });
    });

    describe('structured fields only', () => {
        it('refuses free text (comment.body) and logs it as an alert', async () => {
            const t = await setup();
            const legacy = { ...result(), report: undefined, comment: { body: '[Reset your token](https://evil.test) @org/admins' } };

            const out = await t.useCase.execute(onTheWire(legacy));

            expect(out).toMatchObject({ outcome: 'refused', reason: 'unstructured_body' });
            expect(t.codeManagement.createIssueComment).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ metadata: expect.objectContaining({ alert: 'runtime_publish_refused', reason: 'unstructured_body' }) }),
            );
        });

        it('refuses a completed check without a report, unless it is the fork waiting for a maintainer', async () => {
            const t = await setup();
            const bare = finalCheck({ report: undefined, check: { status: 'completed', conclusion: 'success', title: 'All good', summary: 'trust me' } });
            expect(await t.useCase.execute(onTheWire(bare))).toMatchObject({ outcome: 'refused', reason: 'unstructured_body' });
            expect(t.adapter.createCheckRun).not.toHaveBeenCalled();
        });

        it("never shows the Runtime's check title or summary", async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(awaitingCheck()));

            const created = t.adapter.createCheckRun.mock.calls[0][0];
            expect(created.output!.title).toBe('Waiting for a maintainer');
            expect(JSON.stringify(t.adapter.updateCheckRun.mock.calls)).not.toMatch(/evil\.test|@everyone/);
            expect(t.adapter.updateCheckRun).toHaveBeenCalledWith(expect.objectContaining({ conclusion: CheckConclusion.ACTION_REQUIRED }));
        });

        it('takes the check output from the report, not from the message', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(finalCheck({ check: { status: 'completed', conclusion: 'failure', title: '<img src=x>', summary: '<script>' } })));
            const update = t.adapter.updateCheckRun.mock.calls[0][0];
            expect(update.conclusion).toBe(CheckConclusion.SUCCESS);
            expect(update.output!.title).toBe('No regressions in what was tested');
            expect(JSON.stringify(update)).not.toMatch(/<img|<script>/);
        });
    });

    describe('one comment per PR', () => {
        it('a redelivered comment is published once', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(result()));
            expect(await t.useCase.execute(onTheWire(result()))).toEqual({ outcome: 'duplicate', key: `${RUN_ID}:1:comment` });
            expect(t.codeManagement.createIssueComment).toHaveBeenCalledTimes(1);
        });

        it('two phases delivered at once never both create: the second waits for the slot and edits', async () => {
            const t = await setup();
            let finishCreate!: (v: { id: number }) => void;
            t.codeManagement.createIssueComment.mockImplementationOnce(() => new Promise((resolve) => (finishCreate = resolve)));

            const booting = t.useCase.execute(onTheWire(progress('booting')));
            await new Promise((r) => setImmediate(r));
            await expect(t.useCase.execute(onTheWire(progress('applying')))).rejects.toBeInstanceOf(PublicationBusyError);
            finishCreate({ id: 1001 });
            await booting;

            // The broker redelivers the busy one: it edits the comment the first created.
            expect(await t.useCase.execute(onTheWire(progress('applying')))).toMatchObject({ outcome: 'published', action: 'updated' });
            expect(t.codeManagement.createIssueComment).toHaveBeenCalledTimes(1);
            expect(t.codeManagement.updateIssueComment).toHaveBeenCalledWith(expect.objectContaining({ commentId: 1001 }), PlatformType.GITHUB);
        });

        it('the report waits for the slot a progress update holds, then edits the comment', async () => {
            let release!: () => void;
            const t = await setup({ slotWait: { maxWaitMs: 10_000, sleep: () => new Promise<void>((r) => setImmediate(r)) } });
            await t.useCase.execute(onTheWire(progress('booting')));
            t.codeManagement.updateIssueComment.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ id: 1001 } as any))));

            const reporting = t.useCase.execute(onTheWire(progress('reporting')));
            await new Promise((r) => setImmediate(r));
            // The report lands while the last progress edit still holds the slot: it waits instead of failing.
            const report = t.useCase.execute(onTheWire(result()));
            await new Promise((r) => setImmediate(r));
            release();
            await reporting;
            expect(await report).toMatchObject({ outcome: 'published', action: 'updated' });
            expect(t.codeManagement.createIssueComment).toHaveBeenCalledTimes(1);
        });

        it('a slot still held after the wait goes back to the broker', async () => {
            const t = await setup({ slotWait: { maxWaitMs: 300, sleep: async () => undefined } });
            await t.slots.acquire(PR, 'another-worker');
            await expect(t.useCase.execute(onTheWire(result()))).rejects.toBeInstanceOf(PublicationBusyError);
        });

        it('a failed edit is retried, never turned into a second comment', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(progress('booting')));
            t.codeManagement.updateIssueComment.mockRejectedValueOnce(httpError(502));

            await expect(t.useCase.execute(onTheWire(progress('testing')))).rejects.toThrow('HTTP 502');
            expect(t.codeManagement.createIssueComment).toHaveBeenCalledTimes(1);
            expect(t.publications.rows.get(`${RUN_ID}:1:comment:testing`)?.status).toBe('failed');

            expect(await t.useCase.execute(onTheWire(progress('testing')))).toMatchObject({ outcome: 'published', action: 'updated' });
            expect(t.codeManagement.createIssueComment).toHaveBeenCalledTimes(1);
        });

        it('a comment deleted on the PR (404) or no longer editable (403) is replaced by a new one', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(progress('booting')));
            t.codeManagement.updateIssueComment.mockRejectedValueOnce(httpError(404));

            expect(await t.useCase.execute(onTheWire(progress('testing')))).toMatchObject({ outcome: 'published', action: 'created' });
            expect(t.codeManagement.createIssueComment).toHaveBeenCalledTimes(2);
            expect([...t.slots.rows.values()][0].comment).toEqual({ id: 1002 });
        });

        it('after a create whose answer was lost, finds the marked comment instead of posting again', async () => {
            const t = await setup();
            // A worker died between the platform's create and recording its id.
            await t.slots.acquire(PR, 'dead-worker', new Date(Date.now() - 10 * 60_000));
            await t.slots.update(PR, 'dead-worker', { createPending: true });
            t.codeManagement.getAllCommentsInPullRequest.mockResolvedValueOnce([
                { id: 3, body: 'a human comment' },
                { id: 1001, body: `### Kody Runtime · running\n\n${RUNTIME_COMMENT_MARKER}` },
            ]);

            const out = await t.useCase.execute(onTheWire(progress('testing')));

            expect(out).toMatchObject({ outcome: 'published', action: 'updated' });
            expect(t.codeManagement.getAllCommentsInPullRequest).toHaveBeenCalledWith(expect.objectContaining({ failOnError: true, prNumber: 42 }), PlatformType.GITHUB);
            expect(t.codeManagement.createIssueComment).not.toHaveBeenCalled();
            expect(t.codeManagement.updateIssueComment).toHaveBeenCalledWith(expect.objectContaining({ commentId: 1001 }), PlatformType.GITHUB);
            expect([...t.slots.rows.values()][0]).toMatchObject({ comment: { id: 1001 } });
            expect([...t.slots.rows.values()][0].createPending).toBeUndefined();
        });

        it('creates when a pending create left no marked comment, and a failed create stays pending', async () => {
            const t = await setup();
            t.codeManagement.createIssueComment.mockResolvedValueOnce(null);
            await expect(t.useCase.execute(onTheWire(progress('booting')))).rejects.toBeInstanceOf(PublicationFailedError);
            expect([...t.slots.rows.values()][0]).toMatchObject({ createPending: true });
            expect([...t.slots.rows.values()][0].leaseOwner).toBeUndefined();

            expect(await t.useCase.execute(onTheWire(progress('booting')))).toMatchObject({ outcome: 'published', action: 'created' });
            expect(t.codeManagement.getAllCommentsInPullRequest).toHaveBeenCalledTimes(1);
        });

        it('a phase older than the one shown is skipped', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(result()));
            expect(await t.useCase.execute(onTheWire(progress('testing')))).toMatchObject({ outcome: 'skipped', reason: 'stale_comment' });
            expect(t.codeManagement.updateIssueComment).not.toHaveBeenCalled();
        });
    });

    describe('checks', () => {
        it('opens the check run and closes it with the conclusion of the verdict table', async () => {
            const t = await setup();
            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'published', action: 'created' });
            expect(t.adapter.createCheckRun).toHaveBeenCalledWith(expect.objectContaining({ status: CheckStatus.IN_PROGRESS, headSha: HEAD, repository: { owner: 'acme', name: 'widgets' } }));
            expect(t.adapter.updateCheckRun).toHaveBeenCalledWith(expect.objectContaining({ checkRunId: 555, status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS }));
        });

        it('retries a create that answers no check run, and skips only after every attempt', async () => {
            const t = await setup();
            t.adapter.createCheckRun.mockResolvedValue(null);

            for (let i = 1; i < MAX_CHECK_CREATE_ATTEMPTS; i++) {
                await expect(t.useCase.execute(onTheWire(finalCheck()))).rejects.toBeInstanceOf(PublicationFailedError);
                expect(t.publications.rows.get(`${RUN_ID}:1:check`)).toMatchObject({ status: 'failed', checkCreateFailures: i });
            }
            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'skipped', reason: 'checks_unavailable' });
            expect(t.adapter.createCheckRun).toHaveBeenCalledTimes(MAX_CHECK_CREATE_ATTEMPTS);
        });

        it('a transient null followed by a working create publishes the check', async () => {
            const t = await setup();
            t.adapter.createCheckRun.mockResolvedValueOnce(null);
            await expect(t.useCase.execute(onTheWire(finalCheck()))).rejects.toBeInstanceOf(PublicationFailedError);
            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'published' });
        });

        it('skips at once on a platform without a checks API', async () => {
            const t = await setup({ platform: PlatformType.GITLAB });
            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'skipped', reason: 'checks_unavailable' });
            expect(t.adapter.createCheckRun).not.toHaveBeenCalled();
        });

        it('keeps the opened check run when closing it fails, and the retry closes the same run', async () => {
            const t = await setup();
            t.adapter.updateCheckRun.mockResolvedValueOnce(false);
            await expect(t.useCase.execute(onTheWire(finalCheck()))).rejects.toBeInstanceOf(PublicationFailedError);
            await t.useCase.execute(onTheWire(finalCheck()));
            expect(t.adapter.createCheckRun).toHaveBeenCalledTimes(1);
            expect(t.adapter.updateCheckRun).toHaveBeenLastCalledWith(expect.objectContaining({ checkRunId: 555 }));
        });

        it('moves the check run of the awaiting phase to the final verdict', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(awaitingCheck()));
            await t.useCase.execute(onTheWire(finalCheck()));
            expect(t.adapter.createCheckRun).toHaveBeenCalledTimes(1);
            expect(t.adapter.updateCheckRun).toHaveBeenLastCalledWith(expect.objectContaining({ checkRunId: 555, conclusion: CheckConclusion.SUCCESS }));
        });
    });

    describe('what a redrive needs', () => {
        it('keeps the request of a final comment and a completed check, never of a progress phase', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(progress('booting')));
            await t.useCase.execute(onTheWire(result()));
            await t.useCase.execute(onTheWire(finalCheck()));

            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'comment', 'booting'))?.request).toBeUndefined();
            // The validated message, without the broker envelope or the routing field.
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'comment'))?.request).toEqual(result());
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'check'))?.request).toEqual(finalCheck());
        });

        it('a failed final comment keeps its request for the sweeper', async () => {
            const t = await setup();
            t.codeManagement.createIssueComment.mockResolvedValueOnce(null);
            await expect(t.useCase.execute(onTheWire(result()))).rejects.toBeInstanceOf(PublicationFailedError);
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'comment'))).toMatchObject({ status: 'failed', request: result() });
        });

        it('the fallback replaces the progress with the short notice, marked as such', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(progress('reporting')));
            const out = await t.useCase.execute(result(), { fallback: true });

            expect(out).toMatchObject({ outcome: 'published', action: 'updated' });
            const body = t.codeManagement.updateIssueComment.mock.calls[0][0].body;
            expect(body).toContain('could not post the full report here');
            expect(body).not.toContain('What I tested');
            expect(body.endsWith(RUNTIME_COMMENT_MARKER)).toBe(true);
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'comment'))).toMatchObject({ status: 'published', fallback: true });
        });

        it('the fallback closes a final check neutral with the short notice, never the verdict', async () => {
            const t = await setup();
            const out = await t.useCase.execute(finalCheck(), { fallback: true });

            expect(out).toMatchObject({ outcome: 'published' });
            const update = t.adapter.updateCheckRun.mock.calls.at(-1)[0];
            expect(update.status).toBe(CheckStatus.COMPLETED);
            expect(update.conclusion).toBe(CheckConclusion.NEUTRAL);
            expect(update.output!.title).toBe('Result not posted');
            expect(update.output!.summary).toContain('could not post its result');
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'check'))).toMatchObject({ status: 'published', fallback: true });
        });

        it('the fallback still respects the order: a newer Run keeps its comment', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(progress('booting', '2026-10-31T15:00:00.000Z')));
            const out = await t.useCase.execute(result(), { fallback: true });
            expect(out).toMatchObject({ outcome: 'skipped', reason: 'stale_comment' });
            expect(t.codeManagement.updateIssueComment).not.toHaveBeenCalled();
        });
    });

    describe('metrics', () => {
        it('records every delivery with its outcome, and a thrown one as retry', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire({ ...result(), report: undefined, comment: { body: 'x' } }));
            t.codeManagement.createIssueComment.mockResolvedValueOnce(null);
            await expect(t.useCase.execute(onTheWire(result()))).rejects.toBeInstanceOf(PublicationFailedError);

            expect(t.measurements).toEqual([
                expect.objectContaining({ kind: 'comment', outcome: 'refused', reason: 'unstructured_body' }),
                expect.objectContaining({ kind: 'comment', outcome: 'retry', reason: 'PublicationFailedError' }),
            ]);
        });
    });
});

describe('recoveredCommentRef', () => {
    it('maps a listed comment to the ids an edit needs, per platform', () => {
        expect(recoveredCommentRef({ id: 7 }, PlatformType.GITHUB)).toEqual({ id: 7 });
        expect(recoveredCommentRef({ id: 7, threadId: 'd1' }, PlatformType.GITLAB)).toEqual({ id: 'd1', noteId: 7 });
        expect(recoveredCommentRef({ id: 7, threadId: 3 }, PlatformType.AZURE_REPOS)).toEqual({ id: 7, threadId: 3 });
        expect(recoveredCommentRef(null, PlatformType.GITHUB)).toBeNull();
    });
});
