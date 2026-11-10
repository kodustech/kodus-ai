import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    CheckConclusion,
    type IChecksAdapter,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import {
    publishKey,
    type CommentPhase,
    type RuntimePublishRequested,
    type RuntimeRunReport,
} from '@libs/runtime/run';

import { InMemoryCommentSlotStore } from '../domain/pull-request-comment-slot';
import { InMemoryRunTargetStore } from '../domain/run-target';
import { InMemoryPublicationStore } from '../domain/runtime-publication';
import type {
    CodeManagementPort,
    SuggestionResolver,
} from '../domain/runtime-publish.ports';
import { toPublishRepository } from '../infrastructure/integration-config-repository.resolver';
import {
    commentOrderOf,
    PublicationFailedError,
    PublishRuntimeRequestUseCase,
} from './publish-runtime-request.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const RUN_ID = '0b9f4c1e-8d2a-4f6b-9a3c-1e2d3f4a5b6c';
const NEXT_RUN = '1c0a5d2f-9e3b-4a7c-8b4d-2f3e4a5b6c7d';
const HEAD = 'a'.repeat(40);
const REQUESTED = '2026-10-31T14:00:00.000Z';
const DASHBOARD = 'https://app.kodus.test';

function report(patch: Partial<RuntimeRunReport> = {}): RuntimeRunReport {
    return {
        state: 'regression',
        verdictState: 'regression',
        headSha: HEAD,
        requestedAt: REQUESTED,
        paths: [
            {
                entryPoint: 'POST /orders',
                probeId: 'empty-cart',
                verdict: 'finding',
                intent: 'unintended',
                base: { status: 400 },
                pr: { status: 500 },
                suggestionId: 'sug-1',
            },
        ],
        uncovered: [],
        blockedOutbound: [],
        ...patch,
    };
}

const progress = (phase: CommentPhase, runId = RUN_ID, requestedAt = REQUESTED): RuntimePublishRequested => ({
    runId,
    attempt: 1,
    kind: 'comment',
    key: publishKey(runId, 1, 'comment', phase),
    correlationId: 'corr-1',
    progress: { phase, requestedAt, startedAt: requestedAt },
});

const final = (r: RuntimeRunReport = report(), runId = RUN_ID): RuntimePublishRequested => ({
    runId,
    attempt: 1,
    kind: 'comment',
    key: publishKey(runId, 1, 'comment'),
    correlationId: 'corr-1',
    report: r,
});

async function setup(platform = PlatformType.GITHUB) {
    const targets = new InMemoryRunTargetStore();
    for (const runId of [RUN_ID, NEXT_RUN]) {
        await targets.record({
            runId,
            attempt: 1,
            organizationId: 'org-a',
            teamId: 'team-a',
            repositoryId: 'repo-1',
            repositoryName: 'widgets',
            platform,
            pullRequestNumber: 42,
            headSha: HEAD,
        });
    }
    const publications = new InMemoryPublicationStore();
    let nextId = 1000;
    const codeManagement: jest.Mocked<CodeManagementPort> = {
        getTypeIntegration: jest.fn().mockResolvedValue(platform),
        createIssueComment: jest.fn().mockImplementation(async () => ({ id: ++nextId })),
        updateIssueComment: jest.fn().mockResolvedValue({}),
        getAllCommentsInPullRequest: jest.fn().mockResolvedValue([]),
        createResponseToComment: jest.fn().mockResolvedValue({ id: 3003 }),
    };
    const adapter: jest.Mocked<IChecksAdapter> = {
        findCheckRun: jest.fn().mockResolvedValue(null),
        createCheckRun: jest.fn().mockResolvedValue(555),
        updateCheckRun: jest.fn().mockResolvedValue(true),
    };
    const suggestions: jest.Mocked<SuggestionResolver> = {
        resolve: jest.fn(async ({ suggestionId }) => (suggestionId === 'sug-1' ? { commentId: 777 } : null)),
    };
    const useCase = new PublishRuntimeRequestUseCase(
        targets,
        publications,
        new InMemoryCommentSlotStore(),
        { resolve: async () => toPublishRepository({ id: 'repo-1', name: 'widgets', full_name: 'acme/widgets' }) },
        codeManagement,
        { getAdapter: () => adapter },
        suggestions,
        DASHBOARD,
    );
    return { useCase, codeManagement, adapter, suggestions, publications };
}

describe('Runtime comment edited per phase (screen 6)', () => {
    it('creates the comment at the first phase and edits the same comment at every later phase and at the result', async () => {
        const t = await setup();
        await t.useCase.execute(progress('booting'));
        await t.useCase.execute(progress('testing'));
        await t.useCase.execute(final());

        expect(t.codeManagement.createIssueComment).toHaveBeenCalledTimes(1);
        expect(t.codeManagement.createIssueComment.mock.calls[0][0].body).toContain(
            `[Watch live in Kodus](${DASHBOARD}/runtime/runs/${RUN_ID})`,
        );
        expect(t.codeManagement.updateIssueComment).toHaveBeenCalledTimes(2);
        const last = t.codeManagement.updateIssueComment.mock.calls[1][0];
        expect(last.commentId).toBe(1001);
        expect(last.body.startsWith('### Kody Runtime · 1 regression')).toBe(true);
    });

    it('an earlier phase delivered late does not overwrite a later one', async () => {
        const t = await setup();
        await t.useCase.execute(progress('booting'));
        await t.useCase.execute(final());
        const out = await t.useCase.execute(progress('testing'));
        expect(out).toEqual({ outcome: 'skipped', key: `${RUN_ID}:1:comment:testing`, reason: 'stale_comment' });
        expect(t.codeManagement.updateIssueComment).toHaveBeenCalledTimes(1);
    });

    it('a phase of an older Run does not overwrite the comment of a newer Run on the same PR', async () => {
        const t = await setup();
        await t.useCase.execute(progress('booting', NEXT_RUN, '2026-10-31T15:00:00.000Z'));
        const out = await t.useCase.execute(progress('testing', RUN_ID, REQUESTED));
        expect(out).toMatchObject({ outcome: 'skipped', reason: 'stale_comment' });
    });

    it('the key of a progress comment names its phase; anything else is refused', async () => {
        const t = await setup();
        const wrong = { ...progress('testing'), key: publishKey(RUN_ID, 1, 'comment') };
        expect(await t.useCase.execute(wrong)).toMatchObject({ outcome: 'refused', reason: 'key_mismatch' });
        const two = { ...progress('testing'), report: report() };
        expect(await t.useCase.execute(two)).toMatchObject({ outcome: 'refused', reason: 'invalid_message' });
    });

    it('orders comments by Run and phase', () => {
        const at = Date.parse(REQUESTED) * 10;
        expect(commentOrderOf(progress('booting'))).toBe(at + 1);
        expect(commentOrderOf(progress('reporting'))).toBe(at + 4);
        expect(commentOrderOf(final())).toBe(at + 9);
        expect(commentOrderOf({})).toBeUndefined();
    });

    it('orders by time, not by text: ISO strings of another precision compare right', () => {
        // As text, '…:00.500Z' sorts before '…:00Z' although it is later.
        const later = commentOrderOf(progress('booting', RUN_ID, '2026-10-31T14:00:00.500Z'))!;
        const earlier = commentOrderOf(progress('reporting', RUN_ID, '2026-10-31T14:00:00Z'))!;
        expect(later).toBeGreaterThan(earlier);
    });
});

describe('Reply on the confirmed review suggestion (screen 7)', () => {
    it('replies once in the thread of the review comment the product recorded', async () => {
        const t = await setup();
        await t.useCase.execute(final());
        await t.useCase.execute(final());

        expect(t.suggestions.resolve).toHaveBeenCalledWith({
            organizationAndTeamData: { organizationId: 'org-a', teamId: 'team-a' },
            repositoryId: 'repo-1',
            prNumber: 42,
            suggestionId: 'sug-1',
        });
        expect(t.codeManagement.createResponseToComment).toHaveBeenCalledTimes(1);
        const [params, platform] = t.codeManagement.createResponseToComment.mock.calls[0];
        expect(platform).toBe(PlatformType.GITHUB);
        expect(params).toMatchObject({ prNumber: 42, inReplyToId: 777, repository: { id: 'repo-1', name: 'widgets' } });
        expect(params.body).toContain('**Ran it: confirmed.**');
        expect(t.publications.rows.get(`${RUN_ID}:1:reply:sug-1`)?.status).toBe('published');
    });

    it('skips a suggestion the product does not know on this PR, and intended changes', async () => {
        const t = await setup();
        const r = report({
            paths: [
                { ...report().paths[0], suggestionId: 'unknown' },
                { ...report().paths[0], probeId: 'p2', intent: 'intended', suggestionId: 'sug-1' },
            ],
        });
        await t.useCase.execute(final(r));
        expect(t.codeManagement.createResponseToComment).not.toHaveBeenCalled();
        expect(t.publications.rows.get(`${RUN_ID}:1:reply:unknown`)?.reason).toBe('suggestion_not_found');
    });

    it('does not reply off GitHub', async () => {
        const t = await setup(PlatformType.GITLAB);
        await t.useCase.execute(final());
        expect(t.codeManagement.createResponseToComment).not.toHaveBeenCalled();
        expect(t.publications.rows.get(`${RUN_ID}:1:reply:sug-1`)?.reason).toBe('replies_unavailable');
    });

    it('a failed reply is retried by the redelivery, without posting the comment twice', async () => {
        const t = await setup();
        t.codeManagement.createResponseToComment.mockRejectedValueOnce(new Error('502'));
        await expect(t.useCase.execute(final())).rejects.toBeInstanceOf(PublicationFailedError);
        expect(t.publications.rows.get(`${RUN_ID}:1:comment`)?.status).toBe('published');

        expect(await t.useCase.execute(final())).toEqual({ outcome: 'duplicate', key: `${RUN_ID}:1:comment` });
        expect(t.codeManagement.createIssueComment).toHaveBeenCalledTimes(1);
        expect(t.codeManagement.createResponseToComment).toHaveBeenCalledTimes(2);
        expect(t.publications.rows.get(`${RUN_ID}:1:reply:sug-1`)?.status).toBe('published');
    });
});

describe('Check from the report (screen 9)', () => {
    it('takes title, summary and conclusion from the verdict table applied by the product', async () => {
        const t = await setup();
        await t.useCase.execute({
            runId: RUN_ID,
            attempt: 1,
            kind: 'check',
            key: publishKey(RUN_ID, 1, 'check'),
            correlationId: 'corr-1',
            // The Runtime's own title and conclusion lose to the structured fields.
            check: { status: 'completed', conclusion: 'success', title: 'All good', summary: 'trust me' },
            report: report({ state: 'could_not_boot', verdictState: 'could_not_boot', paths: [], bootFailure: { failsOnBase: true, kind: 'recipe_outdated' } }),
        });
        expect(t.adapter.updateCheckRun).toHaveBeenCalledWith(
            expect.objectContaining({
                conclusion: CheckConclusion.NEUTRAL,
                output: {
                    title: 'Could not boot',
                    summary: `Fails on main too: the recipe is outdated. This is not a bug in the pull request. The review is not affected. · [View run](${DASHBOARD}/runtime/runs/${RUN_ID})`,
                },
            }),
        );
    });
});
