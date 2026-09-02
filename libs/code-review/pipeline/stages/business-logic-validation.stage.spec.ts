import { Test, TestingModule } from '@nestjs/testing';

import { BusinessLogicValidationStage } from './business-logic-validation.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/agents/business-rules-validation/businessRulesValidationAgent';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';

/**
 * Input-contract spec for BusinessLogicValidationStage — the stage that runs the
 * business-rules agent (an LLM call). Guards:
 *  - the skip gate (org/pr/repo required; the business_logic toggle),
 *  - the EXACT input the LLM agent receives (org + byok override + prepareContext),
 *  - the no-task-MCP sentinel and the error path, and
 *  - the invariant that this stage NEVER sets statusInfo=SKIPPED (that would
 *    abort every downstream stage).
 * The two gate predicates that need live infra (connected MCPs, signal
 * matching) are stubbed so the REAL input-assembly code runs under test.
 */
describe('BusinessLogicValidationStage — input contract', () => {
    let stage: BusinessLogicValidationStage;
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
                title: 'feat: PROJ-123 add thing',
                body: 'Closes PROJ-123',
                head: { ref: 'feat/x' },
                base: { ref: 'main' },
            },
            platformType: 'github',
            codeReviewConfig: {
                reviewOptions: { business_logic: true },
                byokModel: 'gpt-5.4',
                byokModelId: 'model-main',
            },
            errors: [],
            ...overrides,
        }) as unknown as CodeReviewPipelineContext;

    /** Let evaluateSkip's live gates pass so the real agent-input assembly runs. */
    const passGate = () => {
        jest.spyOn(stage as any, 'getConnectedTaskManagementMcps').mockResolvedValue([
            'jira',
        ]);
        jest.spyOn(stage as any, 'hasRelevantBusinessSignals').mockReturnValue(true);
    };

    beforeEach(async () => {
        agent = { execute: jest.fn().mockResolvedValue('A business logic gap.') };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BusinessLogicValidationStage,
                { provide: BusinessRulesValidationAgentProvider, useValue: agent },
                { provide: MCPManagerService, useValue: {} },
            ],
        }).compile();

        stage = module.get(BusinessLogicValidationStage);
    });

    it('skips (no agent call) when business_logic is disabled', async () => {
        const context = buildContext({
            codeReviewConfig: { reviewOptions: { business_logic: false } },
        } as any);

        const result = await stage.execute(context);

        expect(agent.execute).not.toHaveBeenCalled();
        expect((result as any).businessLogicOutcome).toMatchObject({
            kind: 'skipped',
            reason: 'option_off',
        });
        // Invariant: this stage must NOT abort the pipeline.
        expect(result.statusInfo?.status).not.toBe(AutomationStatus.SKIPPED);
    });

    it('skips when the org context is missing (no agent call)', async () => {
        const context = buildContext({ organizationAndTeamData: undefined } as any);

        const result = await stage.execute(context);

        expect(agent.execute).not.toHaveBeenCalled();
        expect((result as any).businessLogicOutcome).toMatchObject({
            reason: 'missing_org',
        });
    });

    it('passes org + BYOK override + prepareContext to the agent (the LLM input contract)', async () => {
        passGate();
        const context = buildContext();

        await stage.execute(context);

        expect(agent.execute).toHaveBeenCalledTimes(1);
        const input = agent.execute.mock.calls[0][0];

        // org + per-repo BYOK override threaded from codeReviewConfig
        expect(input.organizationAndTeamData).toBe(ORG);
        expect(input.byokModel).toBe('gpt-5.4');
        expect(input.byokModelId).toBe('model-main');

        // the prompt/context the agent reads
        expect(input.prepareContext).toMatchObject({
            userQuestion: '@kody -v business-logic',
            pullRequestDescription: 'Closes PROJ-123',
            platformType: 'github',
            repository: REPO,
        });
        expect(input.prepareContext.pullRequest.pullRequestNumber).toBe(42);
        expect(input.prepareContext.pullRequest.headRef).toBe('feat/x');
        expect(input.prepareContext.pullRequest.baseRef).toBe('main');
        expect(input.prepareContext.businessSignals).toBeDefined();
        expect(input.thread).toBeDefined();
    });

    it('omits the BYOK override cleanly when the config has none', async () => {
        passGate();
        const context = buildContext({
            codeReviewConfig: { reviewOptions: { business_logic: true } },
        } as any);

        await stage.execute(context);

        const input = agent.execute.mock.calls[0][0];
        expect(input.byokModel).toBeUndefined();
        expect(input.byokModelId).toBeUndefined();
    });

    it('treats the NO_TASK_MCP sentinel as a silent skip', async () => {
        passGate();
        agent.execute.mockResolvedValue(
            BusinessRulesValidationAgentProvider.NO_TASK_MCP_SENTINEL,
        );

        const result = await stage.execute(buildContext());

        expect((result as any).businessLogicResults).toEqual([]);
        expect((result as any).businessLogicOutcome).toMatchObject({
            kind: 'skipped',
            reason: 'no_task_mcp',
        });
    });

    it('records an error without aborting the pipeline when the agent throws', async () => {
        passGate();
        agent.execute.mockRejectedValue(new Error('agent boom'));

        const result = await stage.execute(buildContext());

        expect((result as any).businessLogicResults).toEqual([]);
        expect((result as any).businessLogicOutcome.kind).toBe('error');
        expect(result.errors.length).toBe(1);
        expect(result.errors[0]).toMatchObject({
            stage: 'BusinessLogicValidationStage',
            substage: 'BusinessRulesValidationAgent',
        });
        // The critical invariant: an agent failure must NOT skip the pipeline.
        expect(result.statusInfo?.status).not.toBe(AutomationStatus.SKIPPED);
    });
});
