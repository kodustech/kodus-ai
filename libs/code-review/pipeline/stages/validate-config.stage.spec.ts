import { Test, TestingModule } from '@nestjs/testing';
import { ValidateConfigStage } from './validate-config.stage';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

describe('ValidateConfigStage — byokModel override', () => {
    let stage: ValidateConfigStage;
    let mockAutomationExecutionService: any;
    let mockOrganizationParametersService: any;
    let mockCodeManagementService: any;
    let context: CodeReviewPipelineContext;

    const buildContext = (
        byokModel: string | undefined,
    ): CodeReviewPipelineContext =>
        ({
            origin: 'command',
            platformType: 'github',
            teamAutomationId: 'team-automation-id',
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { id: 'repo-1', name: 'repo' },
            pullRequest: {
                number: 1,
                title: 'feat: something',
                isDraft: false,
                base: { ref: 'main' },
                head: { ref: 'feature' },
            },
            codeReviewConfig: {
                automatedReviewActive: true,
                ignoredTitleKeywords: [],
                baseBranches: [],
                runOnDraft: true,
                byokModel,
            },
        }) as unknown as CodeReviewPipelineContext;

    beforeEach(async () => {
        mockAutomationExecutionService = {
            findLatestExecutionByFilters: jest.fn().mockResolvedValue(null),
        };

        mockOrganizationParametersService = {
            findByKey: jest.fn(),
        };

        mockCodeManagementService = {
            createSingleIssueComment: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ValidateConfigStage,
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: mockAutomationExecutionService,
                },
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: mockOrganizationParametersService,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        stage = module.get<ValidateConfigStage>(ValidateConfigStage);
    });

    it('overrides byokConfig.main.model with byokModel and leaves fallback untouched', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: {
                main: {
                    provider: 'openai',
                    apiKey: 'key',
                    model: 'gpt-4o',
                },
                fallback: {
                    provider: 'anthropic',
                    apiKey: 'key2',
                    model: 'claude-fallback',
                },
            },
        });

        context = buildContext('gpt-5-mini');

        const result = await stage.execute(context);

        expect(result.codeReviewConfig.byokConfig?.main?.model).toBe(
            'gpt-5-mini',
        );
        expect(result.codeReviewConfig.byokConfig?.fallback?.model).toBe(
            'claude-fallback',
        );
    });

    it('does not override the model when byokModel is empty', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: {
                main: { provider: 'openai', apiKey: 'key', model: 'gpt-4o' },
            },
        });

        context = buildContext('');

        const result = await stage.execute(context);

        expect(result.codeReviewConfig.byokConfig?.main?.model).toBe('gpt-4o');
    });

    it('does not override the model when byokModel is undefined', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: {
                main: { provider: 'openai', apiKey: 'key', model: 'gpt-4o' },
            },
        });

        context = buildContext(undefined);

        const result = await stage.execute(context);

        expect(result.codeReviewConfig.byokConfig?.main?.model).toBe('gpt-4o');
    });

    it('does not crash when there is no BYOK config', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue(null);

        context = buildContext('gpt-5-mini');

        const result = await stage.execute(context);

        expect(result.codeReviewConfig.byokConfig).toBeUndefined();
    });
});
