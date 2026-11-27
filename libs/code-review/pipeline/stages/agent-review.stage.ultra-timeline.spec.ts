import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';

import { AgentReviewStage } from './agent-review.stage';

jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return { ...actual, hasManagedModelKey: jest.fn(() => false) };
});

const makeStage = (automationExecutionService: any) =>
    new AgentReviewStage(
        automationExecutionService,
        { findByExternalId: jest.fn().mockResolvedValue(null) } as any,
        { execute: jest.fn() } as any,
        { runLLMInSpan: jest.fn(async ({ runFn }: any) => runFn?.()) } as any,
        { generateContext: jest.fn(), generateContextLegacy: jest.fn() } as any,
        { isEnabled: jest.fn().mockResolvedValue(false) } as any,
        { getReleaseTrack: jest.fn().mockResolvedValue('stable') } as any,
        {
            getRepositories: jest.fn().mockResolvedValue([]),
            getCloneParams: jest.fn().mockResolvedValue(null),
        } as any,
    );

describe('AgentReviewStage — the Ultra merge entry on the timeline', () => {
    it("finishes the entry alone: the execution's own status stays in progress", async () => {
        const automationExecutionService = {
            updateCodeReview: jest
                .fn()
                .mockResolvedValue({ stageLog: { uuid: 'log-1' } }),
            updateStageLog: jest.fn().mockResolvedValue(undefined),
        };
        const stage = makeStage(automationExecutionService);

        await (stage as any).ultraReviewHost().recordTimeline(
            {
                pipelineMetadata: { lastExecution: { uuid: 'exec-1' } },
                organizationAndTeamData: { organizationId: 'o', teamId: 't' },
                pullRequest: { number: 7 },
            },
            {
                stageName: 'AgentReview::ultra-merge',
                label: 'Cross-model merge · m — 4 → 3 comments',
                status: AutomationStatus.SUCCESS,
            },
        );

        // The merge entry is created on the execution, in progress, and the
        // execution is only ever written as in progress here.
        expect(
            automationExecutionService.updateCodeReview,
        ).toHaveBeenCalledWith(
            { uuid: 'exec-1' },
            { status: AutomationStatus.IN_PROGRESS },
            'Cross-model merge · m — 4 → 3 comments',
            'AgentReview::ultra-merge',
            expect.anything(),
        );
        for (const call of automationExecutionService.updateCodeReview.mock
            .calls) {
            expect(call[1]).toEqual({ status: AutomationStatus.IN_PROGRESS });
        }
        expect(automationExecutionService.updateStageLog).toHaveBeenCalledWith(
            'log-1',
            expect.objectContaining({
                status: AutomationStatus.SUCCESS,
                finishedAt: expect.any(Date),
            }),
        );
    });
});

describe('AgentReviewStage — the context of an Ultra run', () => {
    const runContext = (parentSuperseded: boolean, sandbox?: any) =>
        (makeStage({}) as any).ultraReviewHost().runContext(
            {
                sandboxSuperseded: parentSuperseded || undefined,
                codeReviewConfig: {},
            },
            { slot: {} },
            sandbox,
            new AbortController().signal,
        );

    it("reviews on the sandbox it is given, the PR's", () => {
        const sandbox = { id: 'pr' };
        expect(runContext(false, sandbox).sandboxHandle).toBe(sandbox);
    });

    it('keeps a moot review moot, so its runs add no sandbox warning', () => {
        expect(runContext(true).sandboxSuperseded).toBe(true);
        expect(runContext(false).sandboxSuperseded).toBeUndefined();
    });
});
