import type { BusinessValidationOutcome } from '@libs/agents/business-validation/business-validation.types';
import { DEFAULT_BUSINESS_LOGIC_SETTINGS } from '@libs/agents/business-validation/settings';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CheckConclusion } from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';

import {
    BUSINESS_LOGIC_CHECK_NAME,
    BusinessLogicPublisher,
    checkFor,
} from './business-logic-publisher.service';

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
        canWriteChecks?: boolean;
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
    const adapter = {
        canWriteChecks: jest.fn(async () => previous.canWriteChecks ?? true),
        findCheckRun: jest.fn(async () => null),
        createCheckRun: jest.fn(async () => 9001),
        updateCheckRun: jest.fn(async () => true),
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
    const publisher = new BusinessLogicPublisher(
        service as any,
        code as any,
        { getAdapter: () => adapter } as any,
        runs as any,
    );
    return { publisher, service, code, adapter, runs };
}

describe('BusinessLogicPublisher', () => {
    it('comments on a gap and fails the check', async () => {
        const { publisher, code, adapter, runs } = build();

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
        expect(adapter.createCheckRun).toHaveBeenCalledWith(
            expect.objectContaining({
                name: BUSINESS_LOGIC_CHECK_NAME,
                headSha: 'abc1234',
                repository: { owner: 'acme', name: 'notes' },
            }),
        );
        expect(adapter.updateCheckRun).toHaveBeenCalledWith(
            expect.objectContaining({ conclusion: CheckConclusion.FAILURE }),
        );
        expect(runs.create).toHaveBeenCalledWith(
            expect.objectContaining({
                outcome: 'validated',
                passed: false,
                comment: { id: 501 },
                checkRunId: '9001',
            }),
        );
    });

    it('asks for a task and fails the check when the repository requires one', async () => {
        const { publisher, code, adapter, runs } = build();

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
        expect(adapter.updateCheckRun).toHaveBeenCalledWith(
            expect.objectContaining({ conclusion: CheckConclusion.FAILURE }),
        );
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

    it('previews the comment and the check without writing anything', async () => {
        const { publisher, code, adapter, runs } = build();

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
        expect(preview.check).toMatchObject({
            supported: true,
            conclusion: CheckConclusion.FAILURE,
        });
        expect(code.createIssueComment).not.toHaveBeenCalled();
        expect(code.updateIssueComment).not.toHaveBeenCalled();
        expect(adapter.createCheckRun).not.toHaveBeenCalled();
        expect(runs.create).not.toHaveBeenCalled();
    });

    it('says why a met PR gets no comment, and still shows it', async () => {
        const { publisher } = build();

        const preview = await publisher.preview({
            request,
            result: {
                outcome: validated('met'),
                references: [],
                attempts: [],
                trackers: [],
            },
        });

        expect(preview.comment.posted).toBe(false);
        expect(preview.comment.reason).toMatch(
            /Comment when every requirement is met/,
        );
        expect(preview.comment.body).toContain('kody-business-logic');
        expect(preview.check.conclusion).toBe(CheckConclusion.SUCCESS);
    });

    it('promises no check where GitHub is connected with a personal access token', async () => {
        const { publisher } = build({ canWriteChecks: false });

        const preview = await publisher.preview({
            request,
            result: {
                outcome: validated('met'),
                references: [],
                attempts: [],
                trackers: ['Linear'],
            },
        });

        expect(preview.check.supported).toBe(false);
        expect(preview.comment.reason).toContain('no check to turn green');
    });

    it('never promises a green check on a platform without checks', async () => {
        const { publisher } = build();

        const preview = await publisher.preview({
            request: { ...request, platformType: PlatformType.GITLAB },
            result: {
                outcome: validated('met'),
                references: [],
                attempts: [],
                trackers: [],
            },
        });

        expect(preview.check.supported).toBe(false);
        expect(preview.comment.reason).toMatch(/Kody stays quiet/);
        expect(preview.comment.reason).not.toMatch(/check turns green/);
    });

    it('leaves only the green check when every requirement is met (UC-26)', async () => {
        const { publisher, code, adapter } = build();

        await publisher.publish({
            request,
            result: {
                outcome: validated('met'),
                references: [],
                attempts: [],
                trackers: [],
            },
            headSha: 'abc1234',
        });

        expect(code.createIssueComment).not.toHaveBeenCalled();
        expect(adapter.updateCheckRun).toHaveBeenCalledWith(
            expect.objectContaining({ conclusion: CheckConclusion.SUCCESS }),
        );
    });

    it('comments on a met task when the team asked for it', async () => {
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
                commentWhenMet: true,
            },
        });

        expect(code.createIssueComment).toHaveBeenCalled();
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
        const { publisher, code, adapter, runs } = build();

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
        expect(adapter.updateCheckRun).toHaveBeenCalledWith(
            expect.objectContaining({ conclusion: CheckConclusion.SKIPPED }),
        );
        expect(runs.create).toHaveBeenCalledWith(
            expect.objectContaining({
                pendingRecheck: true,
                skipReason: 'tracker_unavailable',
            }),
        );
        expect(runs.clearPendingRecheck).not.toHaveBeenCalled();
    });

    it('writes no check where the platform has none', async () => {
        const { publisher, adapter } = build();

        await publisher.publish({
            request: { ...request, platformType: PlatformType.GITLAB },
            result: {
                outcome: validated('missing'),
                references: [],
                attempts: [],
                trackers: [],
            },
            headSha: 'abc1234',
        });

        expect(adapter.createCheckRun).not.toHaveBeenCalled();
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

describe('checkFor', () => {
    it("is neutral for a task too thin or a typo, so it doesn't block on what the author can't fix in code", () => {
        expect(
            checkFor({
                kind: 'task_too_thin',
                tasks: [{ tracker: 'Linear', id: 'SAA-104' }],
                message: '',
            }).conclusion,
        ).toBe(CheckConclusion.NEUTRAL);
        expect(
            checkFor({ kind: 'skipped', reason: 'no_reference', message: '' })
                .title,
        ).toBe('Skipped · no task referenced');
    });

    it('fails when no task is referenced and the repository requires one', () => {
        expect(checkFor({ kind: 'task_required', message: '' })).toEqual({
            conclusion: CheckConclusion.FAILURE,
            title: 'No task found · this repository requires one',
        });
    });
    it('fails on a typo when the repository requires a task', () => {
        expect(
            checkFor({
                kind: 'task_missing',
                references: [
                    {
                        kind: 'key',
                        id: 'KOD-999',
                        raw: 'KOD-999',
                        source: 'title',
                        intent: 'closes',
                    },
                ],
                tracker: 'Linear',
                message: '',
                required: true,
            }),
        ).toEqual({
            conclusion: CheckConclusion.FAILURE,
            title: "KOD-999 doesn't exist in Linear · this repository requires a task",
        });
    });
});

describe('lastCheckFailed', () => {
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
        await expect(publisher.lastCheckFailed(scope)).resolves.toBe(true);
    });

    it('is false once an acceptance or a fix made the last verdict pass', async () => {
        const { publisher } = build({
            runs: [
                { outcome: 'validated', passed: true },
                { outcome: 'validated', passed: false },
            ],
        });
        await expect(publisher.lastCheckFailed(scope)).resolves.toBe(false);
    });

    it('counts a missing task reference the repository requires as failing', async () => {
        const { publisher } = build({
            runs: [{ outcome: 'task_required', passed: false }],
        });
        await expect(publisher.lastCheckFailed(scope)).resolves.toBe(true);
    });

    it('is false for a task too thin or a typo, which the check leaves neutral', async () => {
        const { publisher } = build({
            runs: [{ outcome: 'task_missing' }],
        });
        await expect(publisher.lastCheckFailed(scope)).resolves.toBe(false);
    });
});
