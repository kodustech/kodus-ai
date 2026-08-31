import { Test, TestingModule } from '@nestjs/testing';

import { ProcessFilesPrLevelReviewStage } from './process-files-pr-level-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/agents/business-rules-validation/businessRulesValidationAgent';
import { KODY_RULES_PR_LEVEL_ANALYSIS_SERVICE_TOKEN } from '@libs/ee/codeBase/kodyRulesPrLevelAnalysis.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';

/**
 * Input-contract spec for ProcessFilesPrLevelReviewStage — the PR-level stage
 * that runs the business-rules agent (an LLM call) and (now) delegates kody
 * rules to AgentReviewStage. Guards the required inputs (org/pr/repo), the
 * fact that business-logic runs even with NO changed files, the exact input
 * the agent receives, the "kody rules is a no-op here" invariant, and that an
 * agent failure records an error without aborting the pipeline.
 */
describe('ProcessFilesPrLevelReviewStage — input contract', () => {
    let stage: ProcessFilesPrLevelReviewStage;
    let agent: { execute: jest.Mock };

    const ORG = { organizationId: 'org-1', teamId: 'team-1' };
    const REPO = { id: 'repo-1', name: 'tiny-url' };

    const buildContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ): CodeReviewPipelineContext =>
        ({
            organizationAndTeamData: ORG,
            repository: REPO,
            pullRequest: {
                number: 42,
                title: 'feat: PROJ-1 thing',
                body: 'Closes PROJ-1',
                head: { ref: 'feat/x' },
                base: { ref: 'main' },
            },
            changedFiles: [{ filename: 'a.ts' }],
            platformType: 'github',
            codeReviewConfig: {},
            errors: [],
            ...overrides,
        }) as unknown as CodeReviewPipelineContext;

    const passGate = () =>
        jest
            .spyOn(stage as any, 'shouldRunBusinessLogicValidation')
            .mockResolvedValue(true);

    beforeEach(async () => {
        agent = { execute: jest.fn().mockResolvedValue('no gap') };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ProcessFilesPrLevelReviewStage,
                { provide: BusinessRulesValidationAgentProvider, useValue: agent },
                { provide: KODY_RULES_PR_LEVEL_ANALYSIS_SERVICE_TOKEN, useValue: {} },
            ],
        }).compile();

        stage = module.get(ProcessFilesPrLevelReviewStage);
    });

    it.each([
        ['org', { organizationAndTeamData: undefined }],
        ['pull request', { pullRequest: undefined }],
        ['repository', { repository: undefined }],
    ])('returns the context untouched (no agent call) when %s is missing', async (_l, patch) => {
        const context = buildContext(patch as any);

        await stage.execute(context);

        expect(agent.execute).not.toHaveBeenCalled();
    });

    it('runs business-logic even when the PR has NO changed files', async () => {
        passGate();
        const context = buildContext({ changedFiles: [] } as any);

        await stage.execute(context);

        expect(agent.execute).toHaveBeenCalledTimes(1);
    });

    it('passes org + prepareContext + thread to the agent (the LLM input contract)', async () => {
        passGate();

        await stage.execute(buildContext());

        expect(agent.execute).toHaveBeenCalledTimes(1);
        const input = agent.execute.mock.calls[0][0];
        expect(input.organizationAndTeamData).toBe(ORG);
        expect(input.thread).toBeDefined();
        expect(input.prepareContext).toMatchObject({
            userQuestion: expect.any(String),
            pullRequestDescription: 'Closes PROJ-1',
            platformType: 'github',
            repository: REPO,
        });
        expect(input.prepareContext.pullRequest.pullRequestNumber).toBe(42);
    });

    it('does NOT add PR-level kody-rules suggestions here (delegated to AgentReviewStage)', async () => {
        passGate();

        const result = await stage.execute(buildContext());

        // runKodyRulesAnalysis is a no-op; nothing from kody rules is pushed here.
        expect((result as any).validSuggestionsByPR).toBeUndefined();
    });

    it('records an agent failure as an error without aborting the pipeline', async () => {
        passGate();
        agent.execute.mockRejectedValue(new Error('agent boom'));

        const result = await stage.execute(buildContext());

        expect(result.errors.some((e: any) => e?.substage === 'BusinessRulesValidationAgent')).toBe(true);
        expect(result.statusInfo?.status).not.toBe(AutomationStatus.SKIPPED);
    });
});
