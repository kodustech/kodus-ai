import type { BusinessValidationOutcome } from '@libs/agents/business-validation/business-validation.types';
import { DEFAULT_BUSINESS_LOGIC_SETTINGS } from '@libs/agents/business-validation/settings';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { BusinessLogicPublisher } from './business-logic-publisher.service';

type Validated = Extract<BusinessValidationOutcome, { kind: 'validated' }>;

const validated = (state: 'met' | 'missing'): Validated => ({
    kind: 'validated',
    checks: [
        {
            task: { tracker: 'Linear', id: 'SAA-96' },
            verdict: {
                needsMoreInfo: false,
                summary: '',
                requirements: [
                    {
                        requirement: 'Order persists',
                        state,
                        evidence: [],
                        confidence: 'high',
                    },
                ],
                outOfScope: [],
            },
            passed: state === 'met',
            readAt: '2026-10-05T12:00:00.000Z',
        },
    ],
    thinTasks: [],
    passed: state === 'met',
    unseenFiles: [],
});

const request = {
    door: 'auto' as const,
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'notes', fullName: 'acme/notes' },
    pullRequest: { number: 47 },
    platformType: PlatformType.GITHUB,
    diff: '',
};

function build(
    previous: {
        verdict?: any;
        comment?: any;
        runs?: any[];
    } = {},
) {
    const service = {
        commentFor: jest.fn(async () => '<!-- kody-business-logic -->\nbody'),
    };
    const code = {
        createIssueComment: jest.fn(async () => ({ id: 501 })),
        updateIssueComment: jest.fn(async () => ({})),
        getAllCommentsInPullRequest: jest.fn(async () => []),
    };
    const runs = {
        latestForPullRequest: jest.fn(
            async (params: { withComment?: boolean }) =>
                params.withComment ? previous.comment : undefined,
        ),
        forPullRequest: jest.fn(
            async () =>
                previous.runs ??
                (previous.verdict
                    ? [{ outcome: 'validated', ...previous.verdict }]
                    : []),
        ),
        create: jest.fn(async () => 'run-1'),
        clearPendingRecheck: jest.fn(async () => undefined),
    };
    const config = {
        getSimpleConfig: jest.fn(async () => ({
            reviewOptions: { business_logic: true },
            businessLogic: { recheckOn: 'push' },
            byokModelId: 'model-dir',
        })),
    };
    const pullRequests = {
        addPrLevelSuggestions: jest.fn(async () => null),
    };
    const publisher = new BusinessLogicPublisher(
        service as any,
        code as any,
        runs as any,
        config as any,
        pullRequests as any,
    );
    return { publisher, service, code, runs, config, pullRequests };
}

describe('BusinessLogicPublisher', () => {
    it('comments on a gap and records the run as failing', async () => {
        const { publisher, code, runs } = build();

        await publisher.publish({
            request,
            result: {
                outcome: validated('missing'),
                references: [],
                attempts: [],
                trackers: ['Linear'],
            },
            headSha: 'abc1234',
        });

        expect(code.createIssueComment).toHaveBeenCalledWith(
            expect.objectContaining({
                prNumber: 47,
                body: expect.stringContaining('kody-business-logic'),
            }),
            PlatformType.GITHUB,
        );
        expect(runs.create).toHaveBeenCalledWith(
            expect.objectContaining({
                outcome: 'validated',
                passed: false,
                comment: { id: 501 },
            }),
        );
    });

    it('records a new comment as a PR-level suggestion once, never again on an edit', async () => {
        const result = {
            outcome: validated('missing'),
            references: [],
            attempts: [],
            trackers: ['Linear'],
        };
        const first = build();
        await first.publisher.publish({ request, result });
        expect(first.pullRequests.addPrLevelSuggestions).toHaveBeenCalledWith(
            47,
            'repo-1',
            'notes',
            [
                expect.objectContaining({
                    label: 'business_logic',
                    deliveryStatus: 'sent',
                    comment: { id: 501 },
                }),
            ],
            request.organizationAndTeamData,
        );

        const edit = build({ comment: { comment: { id: 501 } } });
        await edit.publisher.publish({ request, result });
        expect(edit.pullRequests.addPrLevelSuggestions).not.toHaveBeenCalled();
    });

    it("resolves a door's settings, switch and model with the PR's files, as the review does", async () => {
        const { publisher, code, config } = build();
        (code as any).getFilesByPullRequestId = jest.fn(async () => [
            { filename: 'apps/billing/src/fee.ts' },
        ]);

        await expect(
            publisher.configFor(request.organizationAndTeamData, 'repo-1', {
                number: 47,
                repositoryName: 'notes',
            }),
        ).resolves.toMatchObject({
            enabled: true,
            byokModelId: 'model-dir',
            settings: { recheckOn: 'push' },
        });
        expect(config.getSimpleConfig).toHaveBeenCalledWith(
            request.organizationAndTeamData,
            {
                repositoryId: 'repo-1',
                preliminaryFiles: [{ filename: 'apps/billing/src/fee.ts' }],
            },
        );
    });

    it('asks for a task and records the run as failing when the repository requires one', async () => {
        const { publisher, code, runs } = build();

        await publisher.publish({
            request,
            result: {
                outcome: {
                    kind: 'task_required',
                    message: 'This repository requires a task',
                },
                references: [],
                attempts: [],
                trackers: ['Linear'],
            },
            headSha: 'abc1234',
        });

        expect(code.createIssueComment).toHaveBeenCalled();
        expect(runs.create).toHaveBeenCalledWith(
            expect.objectContaining({
                outcome: 'task_required',
                passed: false,
            }),
        );
    });

    it('posts a new comment when the old one was deleted or cannot be edited', async () => {
        const { publisher, code } = build({ comment: { comment: { id: 77 } } });
        code.updateIssueComment.mockRejectedValueOnce(new Error('Not Found'));

        const result = await publisher.publish({
            request,
            result: {
                outcome: validated('missing'),
                references: [],
                attempts: [],
                trackers: ['Linear'],
            },
            headSha: 'abc1234',
        });

        expect(code.updateIssueComment).toHaveBeenCalled();
        expect(code.createIssueComment).toHaveBeenCalled();
        expect(result.comment).toBe('created');
    });

    it('previews the comment without writing anything', async () => {
        const { publisher, code, runs } = build();

        const preview = await publisher.preview({
            request,
            result: {
                outcome: validated('missing'),
                references: [],
                attempts: [],
                trackers: ['Linear'],
            },
            headSha: 'abc1234',
        });

        expect(preview.comment).toMatchObject({
            posted: true,
            editsExisting: false,
            body: expect.stringContaining('kody-business-logic'),
        });
        expect(code.createIssueComment).not.toHaveBeenCalled();
        expect(code.updateIssueComment).not.toHaveBeenCalled();
        expect(runs.create).not.toHaveBeenCalled();
    });

    it('says why a met PR gets no comment when the team turned that off, and still shows it', async () => {
        const { publisher } = build();

        const preview = await publisher.preview({
            request,
            result: {
                outcome: validated('met'),
                references: [],
                attempts: [],
                trackers: [],
            },
            settings: {
                ...DEFAULT_BUSINESS_LOGIC_SETTINGS,
                commentWhenMet: false,
            },
        });

        expect(preview.comment.posted).toBe(false);
        expect(preview.comment.reason).toMatch(
            /Comment when every requirement is met/,
        );
        expect(preview.comment.body).toContain('kody-business-logic');
    });

    it('comments on a met task by default, on every platform, so the author knows it was checked (UC-26)', async () => {
        for (const platformType of [
            PlatformType.GITHUB,
            PlatformType.GITLAB,
            PlatformType.BITBUCKET,
            PlatformType.AZURE_REPOS,
        ]) {
            const { publisher, code } = build();
            await publisher.publish({
                request: { ...request, platformType },
                result: {
                    outcome: validated('met'),
                    references: [],
                    attempts: [],
                    trackers: [],
                },
                headSha: 'abc1234',
            });
            expect(code.createIssueComment).toHaveBeenCalled();
        }
    });

    it('stays quiet on a met task when the team turned the comment off', async () => {
        const { publisher, code } = build();

        await publisher.publish({
            request,
            result: {
                outcome: validated('met'),
                references: [],
                attempts: [],
                trackers: [],
            },
            settings: {
                ...DEFAULT_BUSINESS_LOGIC_SETTINGS,
                commentWhenMet: false,
            },
        });

        expect(code.createIssueComment).not.toHaveBeenCalled();
    });

    it("edits the PR's comment on a re-check instead of posting another (UC-34)", async () => {
        const { publisher, code } = build({
            comment: { comment: { id: 501 } },
        });

        await publisher.publish({
            request: { ...request, door: 'command' },
            result: {
                outcome: validated('met'),
                references: [],
                attempts: [],
                trackers: [],
            },
            trigger: 'command',
        });

        expect(code.createIssueComment).not.toHaveBeenCalled();
        expect(code.updateIssueComment).toHaveBeenCalledWith(
            expect.objectContaining({ commentId: 501 }),
            PlatformType.GITHUB,
        );
    });

    it('lists the commits checked before this one, oldest first, one line per commit', async () => {
        const run = (headSha: string, state: string, passed: boolean) => ({
            outcome: 'validated',
            headSha,
            passed,
            tasks: [
                {
                    requirements: [{ state }, { state: 'met' }],
                },
            ],
        });
        const { publisher, service } = build({
            // Newest first, as the repository returns them.
            runs: [
                run('ccc3333aaaa', 'met', true),
                { outcome: 'skipped', headSha: 'bbb2222aaaa', tasks: [] },
                run('aaa1111bbbb', 'met', true),
                run('aaa1111aaaa', 'missing', false),
            ],
        });

        await publisher.publish({
            request,
            result: {
                outcome: validated('missing'),
                references: [],
                attempts: [],
                trackers: [],
            },
            headSha: 'ccc3333aaaa',
            trigger: 'push',
        });

        expect(service.commentFor).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                history: [
                    { headSha: 'aaa1111aaaa', met: 1, total: 2, passed: false },
                    { headSha: 'aaa1111bbbb', met: 2, total: 2, passed: true },
                ],
            }),
        );
    });

    it('posts nothing on a skip, marks it for a re-check when the tracker was down (UC-22)', async () => {
        const { publisher, code, runs } = build();

        await publisher.publish({
            request,
            result: {
                outcome: {
                    kind: 'skipped',
                    reason: 'tracker_unavailable',
                    message: 'down',
                },
                references: [],
                attempts: [],
                trackers: ['Linear'],
            },
            headSha: 'abc1234',
        });

        expect(code.createIssueComment).not.toHaveBeenCalled();
        expect(runs.create).toHaveBeenCalledWith(
            expect.objectContaining({
                pendingRecheck: true,
                skipReason: 'tracker_unavailable',
            }),
        );
        expect(runs.clearPendingRecheck).not.toHaveBeenCalled();
    });

    it('keeps an acceptance from the previous run and passes (UC-37)', async () => {
        const { publisher } = build({
            verdict: {
                tasks: [
                    {
                        id: 'SAA-96',
                        requirements: [
                            {
                                requirement: 'Order persists',
                                state: 'missing',
                                evidence: [],
                                confidence: 'high',
                                accepted: { by: 'nina', at: 'x' },
                            },
                        ],
                        outOfScope: [],
                    },
                ],
            },
        });

        const result = await publisher.publish({
            request,
            result: {
                outcome: validated('missing'),
                references: [],
                attempts: [],
                trackers: [],
            },
        });

        expect(
            result.outcome.kind === 'validated' && result.outcome.passed,
        ).toBe(true);
    });
});

describe('lastVerdictFailed', () => {
    const scope = {
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        pullRequestNumber: 47,
    };

    it('reads the last verdict, past runs that were skipped', async () => {
        const { publisher } = build({
            runs: [
                { outcome: 'skipped', skipReason: 'tracker_unavailable' },
                { outcome: 'validated', passed: false },
            ],
        });
        await expect(publisher.lastVerdictFailed(scope)).resolves.toBe(true);
    });

    it('is false once an acceptance or a fix made the last verdict pass', async () => {
        const { publisher } = build({
            runs: [
                { outcome: 'validated', passed: true },
                { outcome: 'validated', passed: false },
            ],
        });
        await expect(publisher.lastVerdictFailed(scope)).resolves.toBe(false);
    });

    it('counts a missing task reference the repository requires as failing', async () => {
        const { publisher } = build({
            runs: [{ outcome: 'task_required', passed: false }],
        });
        await expect(publisher.lastVerdictFailed(scope)).resolves.toBe(true);
    });

    it('is false for a task too thin, or a typo when no task is required', async () => {
        const { publisher } = build({
            runs: [{ outcome: 'task_missing' }],
        });
        await expect(publisher.lastVerdictFailed(scope)).resolves.toBe(false);
    });

    it('counts a typo as failing when the repository requires a task', async () => {
        const { publisher } = build({
            runs: [{ outcome: 'task_missing', passed: false }],
        });
        await expect(publisher.lastVerdictFailed(scope)).resolves.toBe(true);
    });
});
