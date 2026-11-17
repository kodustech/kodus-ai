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

import { RUNTIME_COMMENT_MARKER } from '../domain/render-runtime-comment';
import { type RunTarget } from '../domain/run-target';
import type {
    CodeManagementPort,
    OwnCommentAuthor,
    PublishMeasurement,
    PublishRepository,
} from '../domain/runtime-publish.ports';
import { toPublishRepository } from '../infrastructure/integration-config-repository.resolver';
import { MAX_CHECK_CREATE_ATTEMPTS } from './check-publisher';
import { recoveredCommentRef } from './comment-publisher';
import { PublicationBusyError, PublicationFailedError } from './publication-outcome';
import { PublishRuntimeRequestUseCase, unwrapPublishMessage } from './publish-runtime-request.use-case';
import { InMemoryCommentSlotStore, InMemoryPublicationStore, InMemoryRunTargetStore } from '../testing';

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

const openCheck = (status: 'queued' | 'in_progress'): RuntimePublishRequested => ({
    runId: RUN_ID,
    attempt: 1,
    kind: 'check',
    key: publishKey(RUN_ID, 1, 'check'),
    correlationId: 'corr-1',
    check: { status, title: 'ignored', summary: 'ignored' },
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

/** Kody's GitHub App on this deployment: its comments carry performed_via_github_app.id 77. */
const KODY_APP = 77;
type CommentAuthor = { user?: { id: number; login: string; type?: string }; performed_via_github_app?: { id: number } | null };
/** Who a comment Kody posted shows as its author on the platform. */
const KODY_AUTHOR: CommentAuthor = { user: { id: 9, login: 'kodus[bot]', type: 'Bot' }, performed_via_github_app: { id: KODY_APP } };

type Target = { organizationId: string; teamId: string; repositoryId: string; prNumber: number; platform?: PlatformType };
type Gate = Promise<void>;

/** A deferred step of the platform: the call waits until the test releases it. */
const gate = (): { wait: Gate; release: () => void } => {
    let release!: () => void;
    return { wait: new Promise<void>((r) => (release = r)), release };
};

/**
 * The pull request on the code platform, as a reviewer sees it: the comments
 * on it with every revision of their body. Failures are the platform's
 * answers queued for the next calls: a create with no id, an edit refused
 * with an HTTP status, a listing that fails.
 */
class FakePullRequest implements CodeManagementPort {
    readonly comments = new Map<number, { target: Target; revisions: string[]; author: CommentAuthor }>();
    private nextId = 1000;
    readonly createAnswers: Array<'no_id' | Gate> = [];
    readonly updateAnswers: Array<Error | Gate> = [];
    readonly listErrors: Error[] = [];

    constructor(private readonly platform: PlatformType) {}

    /** The body each comment shows now. */
    bodies(): string[] {
        return [...this.comments.values()].map((c) => c.revisions.at(-1)!);
    }

    /** A comment already on the PR; Kody's own unless another author is named. */
    seed(id: number, body: string, author: CommentAuthor = KODY_AUTHOR) {
        this.comments.set(id, { target: { ...PR }, revisions: [body], author });
        this.nextId = Math.max(this.nextId, id);
    }

    async getTypeIntegration() {
        return this.platform;
    }

    async createIssueComment(params: Parameters<CodeManagementPort['createIssueComment']>[0], platform?: PlatformType) {
        const answer = this.createAnswers.shift();
        if (answer === 'no_id') return null;
        if (answer !== undefined) await answer;
        const id = ++this.nextId;
        const { organizationAndTeamData: o, repository, prNumber, body } = params;
        this.comments.set(id, { target: { organizationId: o.organizationId!, teamId: o.teamId!, repositoryId: repository.id, prNumber, platform }, revisions: [body], author: KODY_AUTHOR });
        return { id };
    }

    async updateIssueComment(params: Parameters<CodeManagementPort['updateIssueComment']>[0]) {
        const answer = this.updateAnswers.shift();
        if (answer instanceof Error) throw answer;
        if (answer !== undefined) await answer;
        const comment = this.comments.get(params.commentId);
        if (!comment) throw httpError(404);
        comment.revisions.push(params.body);
        return { id: params.commentId };
    }

    async getAllCommentsInPullRequest(params: { failOnError?: boolean }) {
        const error = this.listErrors.shift();
        // The platform service answers [] on an error unless asked to fail.
        if (error) {
            if (params.failOnError) throw error;
            return [];
        }
        return [...this.comments].map(([id, c]) => ({ id, body: c.revisions.at(-1), ...c.author }));
    }

    async createResponseToComment() {
        return { id: 2002 };
    }
}

type CommitStatusParams = Parameters<NonNullable<IChecksAdapter['createCommitStatus']>>[0];

/** The check runs on the platform, by id: where they point, their state and what they show. */
class FakeChecks implements IChecksAdapter {
    readonly runs = new Map<number, { headSha: string; name: string; repository: { owner: string; name: string }; status: CheckStatus; conclusion?: CheckConclusion; output: { title: string; summary: string; text?: string } }>();
    private nextId = 555;
    /** The next creates answer no check run (a PAT without checks:write, or a transient error). */
    noRunOnCreate = 0;
    /** The next closes the platform refuses. */
    refusedUpdates = 0;
    /** False: the connection cannot create check runs (a GitHub personal access token). */
    checksApi = true;
    /** The commit statuses on the platform, in the order they were posted. */
    readonly statuses: CommitStatusParams[] = [];
    /** The next commit statuses the platform refuses for a reason that can pass (a 5xx, a rate limit). */
    refusedStatuses = 0;
    /** The token may not write commit statuses (a fine-grained token without "Commit statuses: write"). */
    statusPermissionMissing = false;

    async isChecksApiAvailable() {
        return this.checksApi;
    }

    async createCommitStatus(p: CommitStatusParams) {
        if (this.statusPermissionMissing) return 'permission_missing' as const;
        if (this.refusedStatuses > 0) {
            this.refusedStatuses--;
            return 'failed' as const;
        }
        this.statuses.push(p);
        return 'posted' as const;
    }

    async createCheckRun(p: Parameters<IChecksAdapter['createCheckRun']>[0]) {
        if (!this.checksApi) return null;
        if (this.noRunOnCreate > 0) {
            this.noRunOnCreate--;
            return null;
        }
        const id = this.nextId++;
        this.runs.set(id, { headSha: p.headSha, name: p.name, repository: p.repository, status: p.status, output: p.output });
        return id;
    }

    async updateCheckRun(p: Parameters<IChecksAdapter['updateCheckRun']>[0]) {
        if (this.refusedUpdates > 0) {
            this.refusedUpdates--;
            return false;
        }
        const run = this.runs.get(Number(p.checkRunId));
        if (!run) return false;
        Object.assign(run, { ...(p.status ? { status: p.status } : {}), ...(p.conclusion ? { conclusion: p.conclusion } : {}), ...(p.output ? { output: p.output } : {}) });
        return true;
    }

    async findCheckRun(p: Parameters<IChecksAdapter['findCheckRun']>[0]) {
        return [...this.runs].find(([, r]) => r.headSha === p.headSha && r.name === p.name)?.[0] ?? null;
    }
}

async function setup(opts: { platform?: PlatformType; target?: Partial<RunTarget> | null; slotWait?: { maxWaitMs: number; sleep?: (ms: number) => Promise<void> }; ownAuthor?: OwnCommentAuthor | null } = {}) {
    const platform = opts.platform ?? PlatformType.GITHUB;
    const targets = new InMemoryRunTargetStore();
    if (opts.target !== null) await targets.record(record({ platform, ...opts.target }));
    const publications = new InMemoryPublicationStore();
    const slots = new InMemoryCommentSlotStore();
    const repositories = {
        resolve: async (o: { organizationId?: string; teamId?: string }, id: string) => REPOS[`${o.organizationId}/${o.teamId}/${id}`] ?? null,
    };
    const pr = new FakePullRequest(platform);
    const checks = new FakeChecks();
    const measurements: PublishMeasurement[] = [];
    const authorOf = jest.fn().mockResolvedValue(opts.ownAuthor === undefined ? { userIds: [], githubAppId: KODY_APP } : opts.ownAuthor);
    const useCase = new PublishRuntimeRequestUseCase(
        targets,
        publications,
        slots,
        repositories,
        pr,
        { getAdapter: () => checks },
        undefined,
        DASHBOARD,
        { record: (m) => measurements.push(m) },
        opts.slotWait ?? { maxWaitMs: 0 },
        undefined,
        { ownAuthor: authorOf },
    );
    return { targets, publications, slots, pr, checks, useCase, measurements, authorOf };
}

const PR = { organizationId: 'org-a', teamId: 'team-a', repositoryId: 'repo-1', prNumber: 42 };
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

beforeEach(() => jest.clearAllMocks());

describe('PublishRuntimeRequestUseCase', () => {
    describe('target: only the product-stored record', () => {
        // Behavior: the result lands as one comment on the PR the product recorded, rendered and marked as Kody's.
        it('publishes on the PR of the record, with the rendered and marked body', async () => {
            const t = await setup();
            const out = await t.useCase.execute(onTheWire(result()));

            expect(out).toEqual({ outcome: 'published', key: `${RUN_ID}:1:comment`, action: 'created' });
            const [comment] = [...t.pr.comments.values()];
            expect(t.pr.comments.size).toBe(1);
            expect(comment.target).toEqual({ ...PR, platform: PlatformType.GITHUB });
            expect(comment.revisions[0].startsWith('### Kody Runtime · No regressions')).toBe(true);
            expect(comment.revisions[0].endsWith(RUNTIME_COMMENT_MARKER)).toBe(true);
        });

        // Behavior: a message that names its own PR is refused; nothing appears on any PR.
        it('refuses a message that carries its own target', async () => {
            const t = await setup();
            const out = await t.useCase.execute(onTheWire({ ...result(), organizationId: 'org-b', prNumber: 7 }));
            expect(out).toMatchObject({ outcome: 'refused', reason: 'invalid_message' });
            expect(t.pr.comments.size).toBe(0);
        });

        // Behavior: a record that does not match what the product configured is refused: no comment, no publication row.
        it.each([
            ['an unknown runId', { target: null }, 'target_not_found'],
            ['another attempt', { target: { attempt: 2 } }, 'attempt_mismatch'],
            ['a repo the org and team do not own', { target: { teamId: 'team-z' } }, 'repository_not_in_org'],
            ['a repo name that is not the configured one', { target: { repositoryName: 'other', repositoryFullName: 'x/other' } }, 'repository_mismatch'],
            ['a platform that is not the stored one', { target: { platform: PlatformType.GITLAB } }, 'platform_mismatch'],
        ] as const)('refuses %s', async (_what, opts, reason) => {
            const t = await setup(opts as never);
            expect(await t.useCase.execute(onTheWire(result()))).toMatchObject({ outcome: 'refused', reason });
            expect(t.pr.comments.size).toBe(0);
            expect(t.publications.rows.size).toBe(0);
        });

        // Behavior: only the key of the message's kind, and only this event on the queue, is published.
        it('refuses a key that is not the one of its kind, and another event on the queue', async () => {
            const t = await setup();
            expect(await t.useCase.execute(onTheWire(result({ key: `${RUN_ID}:1:check` })))).toMatchObject({ reason: 'key_mismatch' });
            expect(unwrapPublishMessage({ event_name: 'other', payload: {} })).toEqual({ ok: false, reason: 'unexpected_event' });
            expect(unwrapPublishMessage({ ...result(), workflowType: WorkflowType.CODE_REVIEW })).toEqual({ ok: false, reason: 'unexpected_event' });
        });
    });

    describe('structured fields only', () => {
        // Behavior: free text never reaches the PR, and the attempt raises a security alert (the log line is the alert).
        it('refuses free text (comment.body) and logs it as an alert', async () => {
            const t = await setup();
            const legacy = { ...result(), report: undefined, comment: { body: '[Reset your token](https://evil.test) @org/admins' } };

            const out = await t.useCase.execute(onTheWire(legacy));

            expect(out).toMatchObject({ outcome: 'refused', reason: 'unstructured_body' });
            expect(t.pr.comments.size).toBe(0);
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ metadata: expect.objectContaining({ alert: 'runtime_publish_refused', reason: 'unstructured_body' }) }),
            );
        });

        // Behavior: a completed check needs a report; without one no check run appears on the head.
        it('refuses a completed check without a report, unless it is the fork waiting for a maintainer', async () => {
            const t = await setup();
            const bare = finalCheck({ report: undefined, check: { status: 'completed', conclusion: 'success', title: 'All good', summary: 'trust me' } });
            expect(await t.useCase.execute(onTheWire(bare))).toMatchObject({ outcome: 'refused', reason: 'unstructured_body' });
            expect(t.checks.runs.size).toBe(0);
        });

        // Behavior: the check run shows Kodus's words for the awaiting phase, never the message's title or summary.
        it("never shows the Runtime's check title or summary", async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(awaitingCheck()));

            const [run] = [...t.checks.runs.values()];
            expect(run).toMatchObject({ status: CheckStatus.COMPLETED, conclusion: CheckConclusion.ACTION_REQUIRED, output: { title: 'Waiting for a maintainer' } });
            expect(JSON.stringify(run)).not.toMatch(/evil\.test|@everyone/);
        });

        // Behavior: the check run's conclusion and text come from the report, whatever the message says.
        it('takes the check output from the report, not from the message', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(finalCheck({ check: { status: 'completed', conclusion: 'failure', title: '<img src=x>', summary: '<script>' } })));
            const [run] = [...t.checks.runs.values()];
            expect(run.conclusion).toBe(CheckConclusion.SUCCESS);
            expect(run.output.title).toBe('No regressions in what was tested');
            expect(JSON.stringify(run)).not.toMatch(/<img|<script>/);
        });
    });

    describe('one comment per PR', () => {
        // Behavior: a redelivery never adds a second comment.
        it('a redelivered comment is published once', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(result()));
            expect(await t.useCase.execute(onTheWire(result()))).toEqual({ outcome: 'duplicate', key: `${RUN_ID}:1:comment` });
            expect(t.pr.comments.size).toBe(1);
        });

        // Behavior: two phases delivered at once leave one comment on the PR: the second waits for the slot and edits it.
        it('two phases delivered at once never both create: the second waits for the slot and edits', async () => {
            const t = await setup();
            const create = gate();
            t.pr.createAnswers.push(create.wait);

            const booting = t.useCase.execute(onTheWire(progress('booting')));
            await new Promise((r) => setImmediate(r));
            await expect(t.useCase.execute(onTheWire(progress('applying')))).rejects.toBeInstanceOf(PublicationBusyError);
            create.release();
            await booting;

            // The broker redelivers the busy one: it edits the comment the first created.
            expect(await t.useCase.execute(onTheWire(progress('applying')))).toMatchObject({ outcome: 'published', action: 'updated' });
            expect(t.pr.comments.size).toBe(1);
            expect([...t.pr.comments.values()][0].revisions).toHaveLength(2);
        });

        // Behavior: the report waits for the slot a progress edit holds, then edits the same comment.
        it('the report waits for the slot a progress update holds, then edits the comment', async () => {
            const t = await setup({ slotWait: { maxWaitMs: 10_000, sleep: () => new Promise<void>((r) => setImmediate(r)) } });
            await t.useCase.execute(onTheWire(progress('booting')));
            const edit = gate();
            t.pr.updateAnswers.push(edit.wait);

            const reporting = t.useCase.execute(onTheWire(progress('reporting')));
            await new Promise((r) => setImmediate(r));
            // The report lands while the last progress edit still holds the slot: it waits instead of failing.
            const report = t.useCase.execute(onTheWire(result()));
            await new Promise((r) => setImmediate(r));
            edit.release();
            await reporting;
            expect(await report).toMatchObject({ outcome: 'published', action: 'updated' });
            expect(t.pr.comments.size).toBe(1);
            expect(t.pr.bodies()[0].startsWith('### Kody Runtime · No regressions')).toBe(true);
        });

        // Behavior: a slot another worker still holds after the wait sends the delivery back to the broker.
        it('a slot still held after the wait goes back to the broker', async () => {
            const t = await setup({ slotWait: { maxWaitMs: 300, sleep: async () => undefined } });
            await t.slots.acquire(PR, 'another-worker');
            await expect(t.useCase.execute(onTheWire(result()))).rejects.toBeInstanceOf(PublicationBusyError);
        });

        // Behavior: a failed edit is retried on the same comment, never turned into a second one.
        it('a failed edit is retried, never turned into a second comment', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(progress('booting')));
            t.pr.updateAnswers.push(httpError(502));

            await expect(t.useCase.execute(onTheWire(progress('testing')))).rejects.toThrow('HTTP 502');
            expect(t.pr.comments.size).toBe(1);
            expect(t.publications.rows.get(`${RUN_ID}:1:comment:testing`)?.status).toBe('failed');

            expect(await t.useCase.execute(onTheWire(progress('testing')))).toMatchObject({ outcome: 'published', action: 'updated' });
            expect(t.pr.comments.size).toBe(1);
        });

        // Behavior: a comment someone deleted, or one Kody may no longer edit, is replaced by a new one the slot then points at.
        it.each([
            ['deleted on the PR (404)', (t: Awaited<ReturnType<typeof setup>>) => void t.pr.comments.clear(), 1],
            ['no longer editable (403)', (t: Awaited<ReturnType<typeof setup>>) => void t.pr.updateAnswers.push(httpError(403)), 2],
        ] as const)('a comment %s is replaced by a new one', async (_what, change, onThePr) => {
            const t = await setup();
            await t.useCase.execute(onTheWire(progress('booting')));
            change(t);

            expect(await t.useCase.execute(onTheWire(progress('testing')))).toMatchObject({ outcome: 'published', action: 'created' });
            expect(t.pr.comments.size).toBe(onThePr);
            expect([...t.slots.rows.values()][0].comment).toEqual({ id: 1002 });
            expect(t.pr.comments.get(1002)).toBeDefined();
        });

        // Behavior: after a create whose answer was lost, the marked comment is found and edited; nothing new is posted and a human's comment is untouched.
        it('after a create whose answer was lost, finds the marked comment instead of posting again', async () => {
            const t = await setup();
            // A worker died between the platform's create and recording its id.
            await t.slots.acquire(PR, 'dead-worker', new Date(Date.now() - 10 * 60_000));
            await t.slots.update(PR, 'dead-worker', { createPending: true });
            t.pr.seed(3, 'a human comment', { user: { id: 5, login: 'dev' } });
            t.pr.seed(1001, `### Kody Runtime · running\n\n${RUNTIME_COMMENT_MARKER}`);

            const out = await t.useCase.execute(onTheWire(progress('testing')));

            expect(out).toMatchObject({ outcome: 'published', action: 'updated' });
            expect([...t.pr.comments.keys()]).toEqual([3, 1001]);
            expect(t.pr.comments.get(3)!.revisions).toEqual(['a human comment']);
            expect(t.pr.comments.get(1001)!.revisions).toHaveLength(2);
            expect([...t.slots.rows.values()][0]).toMatchObject({ comment: { id: 1001 } });
            expect([...t.slots.rows.values()][0].createPending).toBeUndefined();
        });

        it("never adopts a marked comment another author posted: it edits Kody's own, or creates a new one (#11)", async () => {
            const body = `### Kody Runtime · running\n\n${RUNTIME_COMMENT_MARKER}`;
            const author: CommentAuthor = { user: { id: 5, login: 'pr-author', type: 'User' }, performed_via_github_app: null };
            const otherApp: CommentAuthor = { user: { id: 6, login: 'other[bot]', type: 'Bot' }, performed_via_github_app: { id: 12 } };
            const kody: CommentAuthor = { user: { id: 9, login: 'kodus[bot]', type: 'Bot' }, performed_via_github_app: { id: KODY_APP } };
            const pending = async (t: Awaited<ReturnType<typeof setup>>) => {
                await t.slots.acquire(PR, 'dead-worker', new Date(Date.now() - 10 * 60_000));
                await t.slots.update(PR, 'dead-worker', { createPending: true });
            };

            // The PR author (and another app) posted the marker after Kody's comment: Kody's is the one edited.
            const t = await setup();
            await pending(t);
            for (const [id, who] of [[1001, kody], [4, author], [5, otherApp]] as Array<[number, CommentAuthor]>) t.pr.seed(id, body, who);
            expect(await t.useCase.execute(onTheWire(progress('testing')))).toMatchObject({ outcome: 'published', action: 'updated' });
            expect(t.pr.comments.get(1001)!.revisions).toHaveLength(2);
            expect(t.authorOf).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a' }), PlatformType.GITHUB);

            // Only someone else's marked comments: none is adopted, Kody posts its own.
            const u = await setup();
            await pending(u);
            for (const [id, who] of [[4, author], [5, otherApp]] as Array<[number, CommentAuthor]>) u.pr.seed(id, body, who);
            expect(await u.useCase.execute(onTheWire(progress('testing')))).toMatchObject({ outcome: 'published', action: 'created' });
            expect([...u.pr.comments.values()].filter((c) => c.revisions.length > 1)).toEqual([]);

            // A token integration posts as its user: that user's marked comment is Kody's.
            const v = await setup({ ownAuthor: { userIds: ['9'] } });
            await pending(v);
            for (const [id, who] of [[4, author], [1001, { user: { id: 9, login: 'kody-token-user' } }]] as Array<[number, CommentAuthor]>) v.pr.seed(id, body, who);
            expect(await v.useCase.execute(onTheWire(progress('testing')))).toMatchObject({ outcome: 'published', action: 'updated' });
            expect(v.pr.comments.get(1001)!.revisions).toHaveLength(2);

            // Who Kody posts as is unknown: nothing is adopted.
            const w = await setup({ ownAuthor: null });
            await pending(w);
            for (const [id, who] of [[1001, kody]] as Array<[number, CommentAuthor]>) w.pr.seed(id, body, who);
            expect(await w.useCase.execute(onTheWire(progress('testing')))).toMatchObject({ outcome: 'published', action: 'created' });
            expect([...w.pr.comments.values()].filter((c) => c.revisions.length > 1)).toEqual([]);
        });

        // Behavior: a listing the platform failed is not read as "no comment": nothing is posted and the delivery is retried.
        it('a failed listing after a lost create posts nothing and goes back to the broker', async () => {
            const t = await setup();
            await t.slots.acquire(PR, 'dead-worker', new Date(Date.now() - 10 * 60_000));
            await t.slots.update(PR, 'dead-worker', { createPending: true });
            t.pr.seed(1001, `### Kody Runtime · running\n\n${RUNTIME_COMMENT_MARKER}`);
            t.pr.listErrors.push(httpError(502));

            await expect(t.useCase.execute(onTheWire(progress('testing')))).rejects.toThrow();
            expect([...t.pr.comments.keys()]).toEqual([1001]);
        });

        // Behavior: a create the platform answered without an id stays pending; the redelivery finds no marked comment and creates exactly one.
        it('creates when a pending create left no marked comment, and a failed create stays pending', async () => {
            const t = await setup();
            t.pr.createAnswers.push('no_id');
            await expect(t.useCase.execute(onTheWire(progress('booting')))).rejects.toBeInstanceOf(PublicationFailedError);
            expect([...t.slots.rows.values()][0]).toMatchObject({ createPending: true });
            expect([...t.slots.rows.values()][0].leaseOwner).toBeUndefined();

            expect(await t.useCase.execute(onTheWire(progress('booting')))).toMatchObject({ outcome: 'published', action: 'created' });
            expect(t.pr.comments.size).toBe(1);
        });

        // Behavior: a phase older than the one the comment shows leaves the comment as it is.
        it('a phase older than the one shown is skipped', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(result()));
            expect(await t.useCase.execute(onTheWire(progress('testing')))).toMatchObject({ outcome: 'skipped', reason: 'stale_comment' });
            expect([...t.pr.comments.values()][0].revisions).toHaveLength(1);
        });
    });

    describe('checks', () => {
        // Behavior: the head gets one check run, on the configured repository, closed with the verdict table's conclusion.
        it('opens the check run and closes it with the conclusion of the verdict table', async () => {
            const t = await setup();
            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'published', action: 'created' });
            expect([...t.checks.runs.values()]).toEqual([
                expect.objectContaining({ headSha: HEAD, repository: { owner: 'acme', name: 'widgets' }, status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS }),
            ]);
            expect(t.checks.statuses).toEqual([]);
        });

        // Behavior: a platform that creates no check run is retried delivery by delivery and skipped only after every attempt.
        it('retries a create that answers no check run, and skips only after every attempt', async () => {
            const t = await setup();
            t.checks.noRunOnCreate = MAX_CHECK_CREATE_ATTEMPTS;

            for (let i = 1; i < MAX_CHECK_CREATE_ATTEMPTS; i++) {
                await expect(t.useCase.execute(onTheWire(finalCheck()))).rejects.toBeInstanceOf(PublicationFailedError);
                expect(t.publications.rows.get(`${RUN_ID}:1:check`)).toMatchObject({ status: 'failed', checkCreateFailures: i });
            }
            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'skipped', reason: 'checks_unavailable' });
            expect(t.checks.runs.size).toBe(0);
        });

        // Behavior: one transient miss does not cost the check: the next delivery publishes it.
        it('a transient null followed by a working create publishes the check', async () => {
            const t = await setup();
            t.checks.noRunOnCreate = 1;
            await expect(t.useCase.execute(onTheWire(finalCheck()))).rejects.toBeInstanceOf(PublicationFailedError);
            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'published' });
            expect([...t.checks.runs.values()]).toEqual([expect.objectContaining({ status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS })]);
        });

        // Behavior: a platform without a checks API gets no check run, and the delivery is done.
        it('skips at once on a platform without a checks API', async () => {
            const t = await setup({ platform: PlatformType.GITLAB });
            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'skipped', reason: 'checks_unavailable' });
            expect(t.checks.runs.size).toBe(0);
        });

        // Behavior: a close the platform refused is retried on the run already opened, never a second run.
        it('keeps the opened check run when closing it fails, and the retry closes the same run', async () => {
            const t = await setup();
            t.checks.refusedUpdates = 1;
            await expect(t.useCase.execute(onTheWire(finalCheck()))).rejects.toBeInstanceOf(PublicationFailedError);
            await t.useCase.execute(onTheWire(finalCheck()));
            expect([...t.checks.runs.values()]).toEqual([expect.objectContaining({ status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS })]);
        });

        // Behavior: the run the awaiting phase opened is the one the final verdict closes.
        it('moves the check run of the awaiting phase to the final verdict', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(awaitingCheck()));
            await t.useCase.execute(onTheWire(finalCheck()));
            expect([...t.checks.runs.values()]).toEqual([expect.objectContaining({ conclusion: CheckConclusion.SUCCESS })]);
        });

        // Behavior: a waiting phase delivered after the verdict leaves the verdict on the check run; the late phase is skipped.
        it('a late awaiting phase never moves the closed check run back', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(finalCheck()));
            expect(await t.useCase.execute(onTheWire(awaitingCheck()))).toMatchObject({ outcome: 'skipped', reason: 'superseded_by_final' });
            expect([...t.checks.runs.values()]).toEqual([expect.objectContaining({ status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS })]);
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'check', 'awaiting_approval'))).toMatchObject({ status: 'skipped', reason: 'superseded_by_final' });
        });
    });

    describe('a connection without check runs: the verdict as a commit status', () => {
        // Behavior: an org whose GitHub connection is a personal access token gets the verdict as a commit status named like the check, on the PR head, and the publication is published.
        it('posts the verdict as a commit status on the head and records it as published', async () => {
            const t = await setup();
            t.checks.checksApi = false;

            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'published', key: `${RUN_ID}:1:check` });

            expect(t.checks.runs.size).toBe(0);
            expect(t.checks.statuses).toEqual([
                expect.objectContaining({
                    repository: { owner: 'acme', name: 'widgets' },
                    sha: HEAD,
                    context: 'Kody Runtime',
                    status: CheckStatus.COMPLETED,
                    conclusion: CheckConclusion.SUCCESS,
                    description: 'No regressions in what was tested',
                    targetUrl: `${DASHBOARD}/runtime/runs/${RUN_ID}`,
                }),
            ]);
            const row = t.publications.rows.get(`${RUN_ID}:1:check`);
            expect(row).toMatchObject({ status: 'published', commitStatus: true });
            expect(row?.checkCreateFailures).toBeUndefined();
        });

        // Behavior: every phase moves the same status: open while the Run waits or runs, the verdict at the end.
        it('moves one status through the phases, the awaiting maintainer included, to the verdict', async () => {
            const t = await setup();
            t.checks.checksApi = false;

            await t.useCase.execute(onTheWire(awaitingCheck()));
            await t.useCase.execute(onTheWire(openCheck('queued')));
            await t.useCase.execute(onTheWire(openCheck('in_progress')));
            await t.useCase.execute(onTheWire(finalCheck({ report: report({ state: 'regression', verdictState: 'regression', paths: [{ entryPoint: 'GET /orders', probeId: 'list', verdict: 'finding', base: { status: 200 }, pr: { status: 500 } }] }) })));

            expect(t.checks.statuses.map((s) => [s.context, s.status, s.conclusion, s.description])).toEqual([
                ['Kody Runtime', CheckStatus.COMPLETED, CheckConclusion.ACTION_REQUIRED, 'Waiting for a maintainer'],
                ['Kody Runtime', CheckStatus.QUEUED, undefined, 'Queued'],
                ['Kody Runtime', CheckStatus.IN_PROGRESS, undefined, 'Running'],
                ['Kody Runtime', CheckStatus.COMPLETED, CheckConclusion.FAILURE, '1 regression'],
            ]);
            expect(t.checks.runs.size).toBe(0);
        });

        // Behavior: a status the platform refuses is retried delivery by delivery, then skipped so the comment carries the result.
        it('retries a refused status, and skips only after every attempt', async () => {
            const t = await setup();
            t.checks.checksApi = false;
            t.checks.refusedStatuses = MAX_CHECK_CREATE_ATTEMPTS;

            for (let i = 1; i < MAX_CHECK_CREATE_ATTEMPTS; i++) {
                await expect(t.useCase.execute(onTheWire(finalCheck()))).rejects.toBeInstanceOf(PublicationFailedError);
                expect(t.publications.rows.get(`${RUN_ID}:1:check`)).toMatchObject({ status: 'failed', checkCreateFailures: i });
            }
            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'skipped', reason: 'checks_unavailable' });
            expect(t.checks.statuses).toEqual([]);
        });

        // Behavior: a token that may not write commit statuses is skipped at once, with a reason the Run page turns into the permission to give.
        it('skips at once when the token may not write commit statuses, and says so', async () => {
            const t = await setup();
            t.checks.checksApi = false;
            t.checks.statusPermissionMissing = true;

            expect(await t.useCase.execute(onTheWire(finalCheck()))).toMatchObject({ outcome: 'skipped', reason: 'status_permission_missing' });
            expect(t.publications.rows.get(`${RUN_ID}:1:check`)).toMatchObject({ status: 'skipped', reason: 'status_permission_missing' });
            expect(t.checks.statuses).toEqual([]);
        });

        // Behavior: commit statuses are append-only per context, so a waiting phase delivered after the verdict is not posted: the verdict stays the latest status.
        it('a late awaiting phase never turns the posted verdict back to pending', async () => {
            const t = await setup();
            t.checks.checksApi = false;

            await t.useCase.execute(onTheWire(finalCheck()));
            expect(await t.useCase.execute(onTheWire(awaitingCheck()))).toMatchObject({ outcome: 'skipped', reason: 'superseded_by_final' });

            expect(t.checks.statuses.map((s) => [s.status, s.conclusion])).toEqual([[CheckStatus.COMPLETED, CheckConclusion.SUCCESS]]);
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'check', 'awaiting_approval'))).toMatchObject({ status: 'skipped', reason: 'superseded_by_final' });
        });

        // Behavior: a verdict not posted yet (its delivery failed) does not stop the waiting phase.
        it('a waiting phase still posts while the verdict is not on the PR', async () => {
            const t = await setup();
            t.checks.checksApi = false;
            t.checks.refusedStatuses = 1;

            await expect(t.useCase.execute(onTheWire(finalCheck()))).rejects.toBeInstanceOf(PublicationFailedError);
            expect(await t.useCase.execute(onTheWire(awaitingCheck()))).toMatchObject({ outcome: 'published' });
            expect(t.checks.statuses.map((s) => s.conclusion)).toEqual([CheckConclusion.ACTION_REQUIRED]);
        });

        // Behavior: the sweeper's fallback reaches a token connection too, as the neutral short notice.
        it('the fallback posts the short notice as a neutral status', async () => {
            const t = await setup();
            t.checks.checksApi = false;
            expect(await t.useCase.execute(finalCheck(), { fallback: true })).toMatchObject({ outcome: 'published' });
            expect(t.checks.statuses).toEqual([expect.objectContaining({ status: CheckStatus.COMPLETED, conclusion: CheckConclusion.NEUTRAL, description: 'Result not posted' })]);
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'check'))).toMatchObject({ status: 'published', fallback: true, commitStatus: true });
        });
    });

    describe('what a redrive needs', () => {
        // Behavior: the request a sweeper replays is kept for the final comment and the completed check, never for a progress phase.
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

        // Behavior: a final comment that failed keeps its request for the sweeper.
        it('a failed final comment keeps its request for the sweeper', async () => {
            const t = await setup();
            t.pr.createAnswers.push('no_id');
            await expect(t.useCase.execute(onTheWire(result()))).rejects.toBeInstanceOf(PublicationFailedError);
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'comment'))).toMatchObject({ status: 'failed', request: result() });
        });

        // Behavior: the fallback edits the progress comment into the short notice, marked as Kody's.
        it('the fallback replaces the progress with the short notice, marked as such', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(progress('reporting')));
            const out = await t.useCase.execute(result(), { fallback: true });

            expect(out).toMatchObject({ outcome: 'published', action: 'updated' });
            expect(t.pr.comments.size).toBe(1);
            const body = t.pr.bodies()[0];
            expect(body).toContain('could not post the full report here');
            expect(body).not.toContain('What I tested');
            expect(body.endsWith(RUNTIME_COMMENT_MARKER)).toBe(true);
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'comment'))).toMatchObject({ status: 'published', fallback: true });
        });

        // Behavior: the fallback closes the final check neutral with the short notice, never the verdict.
        it('the fallback closes a final check neutral with the short notice, never the verdict', async () => {
            const t = await setup();
            const out = await t.useCase.execute(finalCheck(), { fallback: true });

            expect(out).toMatchObject({ outcome: 'published' });
            const [run] = [...t.checks.runs.values()];
            expect(run.status).toBe(CheckStatus.COMPLETED);
            expect(run.conclusion).toBe(CheckConclusion.NEUTRAL);
            expect(run.output.title).toBe('Result not posted');
            expect(run.output.summary).toContain('could not post its result');
            expect(t.publications.rows.get(publishKey(RUN_ID, 1, 'check'))).toMatchObject({ status: 'published', fallback: true });
        });

        // Behavior: a fallback for an older Run leaves a newer Run's comment as it is.
        it('the fallback still respects the order: a newer Run keeps its comment', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire(progress('booting', '2026-10-31T15:00:00.000Z')));
            const out = await t.useCase.execute(result(), { fallback: true });
            expect(out).toMatchObject({ outcome: 'skipped', reason: 'stale_comment' });
            expect([...t.pr.comments.values()][0].revisions).toHaveLength(1);
        });
    });

    describe('metrics', () => {
        // Behavior: every delivery is measured with its outcome; one that throws counts as a retry.
        it('records every delivery with its outcome, and a thrown one as retry', async () => {
            const t = await setup();
            await t.useCase.execute(onTheWire({ ...result(), report: undefined, comment: { body: 'x' } }));
            t.pr.createAnswers.push('no_id');
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
