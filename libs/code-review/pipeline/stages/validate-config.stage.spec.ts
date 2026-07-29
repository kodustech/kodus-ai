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

describe('ValidateConfigStage — v2 routing', () => {
    let stage: ValidateConfigStage;
    let mockAutomationExecutionService: any;
    let mockOrganizationParametersService: any;
    let mockCodeManagementService: any;

    const buildContext = (
        byokModel: string | undefined,
        byokModelId?: string | undefined,
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
                byokModelId,
            },
        }) as unknown as CodeReviewPipelineContext;

    // openai gpt-* → structuredOutput json_schema (eligible for codeReview);
    // anthropic claude-* → structuredOutput none (NOT eligible).
    const v2 = (routing: any, models?: any[], credentials?: any[]) => ({
        version: 2,
        credentials: credentials ?? [
            { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' },
        ],
        models: models ?? [
            { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
            { id: 'm-B', credentialId: 'c-oa', model: 'gpt-5-mini' },
        ],
        routing,
    });

    beforeEach(async () => {
        mockAutomationExecutionService = {
            findLatestExecutionByFilters: jest.fn().mockResolvedValue(null),
        };
        mockOrganizationParametersService = { findByKey: jest.fn() };
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

    it('routes the codeReview task to the taskOverride model (ciphertext preserved)', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: v2({
                taskOverrides: { codeReview: 'm-B' },
                defaultModelId: 'm-A',
            }),
        });

        const result = await stage.execute(buildContext(undefined));

        expect(result.codeReviewConfig.byokConfig?.main?.model).toBe(
            'gpt-5-mini',
        );
        expect(result.codeReviewConfig.byokConfig?.main?.provider).toBe(
            'openai',
        );
        // Slot carries ciphertext verbatim — the resolver never decrypts.
        expect(result.codeReviewConfig.byokConfig?.main?.apiKey).toBe('enc-oa');
    });

    it('routes the codeReview task to the byokModelId id-override (top of precedence)', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: v2({ defaultModelId: 'm-A' }),
        });

        // byokModelId 'm-B' is a v2 models[] id → routes straight to that model.
        const result = await stage.execute(buildContext(undefined, 'm-B'));

        expect(result.codeReviewConfig.byokConfig?.main?.model).toBe(
            'gpt-5-mini',
        );
        expect(result.codeReviewConfig.byokConfig?.main?.apiKey).toBe('enc-oa');
    });

    it('lets byokModelId (id) win over the legacy byokModel NAME', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: v2({ defaultModelId: 'm-A' }),
        });

        // id 'm-B' (→ gpt-5-mini) wins over the NAME 'gpt-4o'.
        const result = await stage.execute(buildContext('gpt-4o', 'm-B'));

        expect(result.codeReviewConfig.byokConfig?.main?.model).toBe(
            'gpt-5-mini',
        );
    });

    it('W1: a legacy byokModel NAME override still resolves on a v2 config', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: v2({ defaultModelId: 'm-A' }),
        });

        // 'gpt-5-mini' is a model NAME, not a models[] id → applied onto the
        // chosen slot (default m-A, openai credential).
        const result = await stage.execute(buildContext('gpt-5-mini'));

        expect(result.codeReviewConfig.byokConfig?.main?.model).toBe(
            'gpt-5-mini',
        );
        expect(result.codeReviewConfig.byokConfig?.main?.apiKey).toBe('enc-oa');
    });

    it('materializes the fallback slot from routing.fallbackModelId', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: v2({
                defaultModelId: 'm-A',
                fallbackModelId: 'm-B',
            }),
        });

        const result = await stage.execute(buildContext(undefined));

        expect(result.codeReviewConfig.byokConfig?.main?.model).toBe('gpt-4o');
        expect(result.codeReviewConfig.byokConfig?.fallback?.model).toBe(
            'gpt-5-mini',
        );
    });

    it('degrades to the env/managed default (byokConfig undefined) on a BLOCKED verdict', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            // Only an anthropic model (structuredOutput none) — ineligible for
            // codeReview — and no fallback → BLOCKED.
            configValue: v2(
                { defaultModelId: 'm-ANT' },
                [{ id: 'm-ANT', credentialId: 'c-an', model: 'claude-3-5' }],
                [{ id: 'c-an', provider: 'anthropic', apiKey: 'enc-an' }],
            ),
        });

        const result = await stage.execute(buildContext(undefined));

        expect(result.codeReviewConfig.byokConfig).toBeUndefined();
    });
});
