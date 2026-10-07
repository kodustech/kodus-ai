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

function build(previous: { verdict?: any; comment?: any } = {}) {
    const service = {
        commentFor: jest.fn(async () => '<!-- kody-business-logic -->\nbody'),
    };
    const code = {
        createIssueComment: jest.fn(async () => ({ id: 501 })),
        updateIssueComment: jest.fn(async () => ({})),
        getAllCommentsInPullRequest: jest.fn(async () => []),
    };
    const adapter = {
        findCheckRun: jest.fn(async () => null),
        createCheckRun: jest.fn(async () => 9001),
        updateCheckRun: jest.fn(async () => true),
    };
    const runs = {
        latestForPullRequest: jest.fn(
            async (params: { outcome?: string; withComment?: boolean }) =>
                params.outcome
                    ? previous.verdict
                    : params.withComment
                      ? previous.comment
                      : undefined,
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
});
