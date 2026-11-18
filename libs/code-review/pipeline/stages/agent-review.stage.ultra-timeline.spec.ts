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

        // The execution is only ever written as in progress here.
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
