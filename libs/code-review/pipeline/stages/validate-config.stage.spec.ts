import { Test, TestingModule } from '@nestjs/testing';
import { ValidateConfigStage } from './validate-config.stage';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { ignoredFilesForCustomAgents } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope';
import { CUSTOM_AGENTS_PLAN_REQUIRED } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agents-plan';
import { LICENSE_SERVICE_TOKEN } from '@libs/ee/license/interfaces/license.interface';

describe('ValidateConfigStage — no BYOK config', () => {
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

        expect(result.codeReviewConfig.byokConfig?.model).toBe(
            'gpt-5-mini',
        );
        expect(result.codeReviewConfig.byokConfig?.provider).toBe(
            'openai',
        );
        // Slot carries ciphertext verbatim — the resolver never decrypts.
        expect(result.codeReviewConfig.byokConfig?.apiKey).toBe('enc-oa');
    });

    it('routes the codeReview task to the byokModelId id-override (top of precedence)', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: v2({ defaultModelId: 'm-A' }),
        });

        // byokModelId 'm-B' is a models[] id → routes straight to that model.
        const result = await stage.execute(buildContext(undefined, 'm-B'));

        expect(result.codeReviewConfig.byokConfig?.model).toBe(
            'gpt-5-mini',
        );
        expect(result.codeReviewConfig.byokConfig?.apiKey).toBe('enc-oa');
    });

    it('lets byokModelId (id) win over the legacy byokModel NAME', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: v2({ defaultModelId: 'm-A' }),
        });

        // id 'm-B' (→ gpt-5-mini) wins over the NAME 'gpt-4o'.
        const result = await stage.execute(buildContext('gpt-4o', 'm-B'));

        expect(result.codeReviewConfig.byokConfig?.model).toBe(
            'gpt-5-mini',
        );
    });

    it('W1: a legacy byokModel NAME override still resolves on a config', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: v2({ defaultModelId: 'm-A' }),
        });

        // 'gpt-5-mini' is a model NAME, not a models[] id → applied onto the
        // chosen slot (default m-A, openai credential).
        const result = await stage.execute(buildContext('gpt-5-mini'));

        expect(result.codeReviewConfig.byokConfig?.model).toBe(
            'gpt-5-mini',
        );
        expect(result.codeReviewConfig.byokConfig?.apiKey).toBe('enc-oa');
    });

    it('resolves the main slot and carries routing.fallbackModelId as the runtime failover', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            configValue: v2({
                defaultModelId: 'm-A',
                fallbackModelId: 'm-B',
            }),
        });

        const result = await stage.execute(buildContext(undefined));

        // Primary = the routed default; the org's fallback rides on `.fallback`
        // (stamped by resolveTaskSlot) so LLM.run can cascade primary→fallback at
        // runtime. The fallback slot is flagged usedFallback for the span.
        expect(result.codeReviewConfig.byokConfig?.model).toBe('gpt-4o');
        const fallback = (
            result.codeReviewConfig.byokConfig as {
                fallback?: { model?: string; usedFallback?: boolean };
            }
        )?.fallback;
        expect(fallback?.model).toBe('gpt-5-mini');
        expect(fallback?.usedFallback).toBe(true);
    });

    it('degrades to the env/managed default (byokConfig undefined) on a BLOCKED verdict', async () => {
        mockOrganizationParametersService.findByKey.mockResolvedValue({
            // Model on an UNREGISTERED provider → no candidate qualifies →
            // BLOCKED. (The capability gate no longer blocks anything for
            // codeReview since every provider does native tool calling, so an
            // unregistered provider is the stable way to exercise the degrade.)
            configValue: v2(
                { defaultModelId: 'm-X' },
                [{ id: 'm-X', credentialId: 'c-x', model: 'some-model' }],
                [{ id: 'c-x', provider: 'not_a_real_provider', apiKey: 'enc-x' }],
            ),
        });

        const result = await stage.execute(buildContext(undefined));

        expect(result.codeReviewConfig.byokConfig).toBeUndefined();
    });
});

describe('ValidateConfigStage — base branch scope', () => {
    let stage: ValidateConfigStage;

    const orgAndTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

    const validate = (
        configBaseBranches: string[] | undefined,
        apiBaseBranch: string | undefined,
        targetBranch: string,
        sourceBranch = 'feature/x',
    ) =>
        stage['_isBranchLogicValid'](
            sourceBranch,
            targetBranch,
            configBaseBranches,
            apiBaseBranch,
            'github' as any,
            orgAndTeam,
        );

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ValidateConfigStage,
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: { findLatestExecutionByFilters: jest.fn() },
                },
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: { findByKey: jest.fn() },
                },
                {
                    provide: CodeManagementService,
                    useValue: { createSingleIssueComment: jest.fn() },
                },
            ],
        }).compile();

        stage = module.get<ValidateConfigStage>(ValidateConfigStage);
    });

    describe('missing config (undefined / not an array)', () => {
        it('does not block when baseBranches is undefined', () => {
            expect(validate(undefined, 'main', 'develop').canProceed).toBe(true);
        });

        it('does not block when baseBranches is corrupt', () => {
            expect(validate('main' as any, 'main', 'develop').canProceed).toBe(
                true,
            );
        });
    });

    describe('empty list — scope is the repository default branch', () => {
        it('reviews a PR targeting the default branch', () => {
            expect(validate([], 'main', 'main').canProceed).toBe(true);
        });

        it('skips a PR targeting a non-default branch', () => {
            const result = validate([], 'main', 'develop');

            expect(result.canProceed).toBe(false);
            expect(result.details?.message).toContain('develop');
        });

        it('falls back to reviewing when the default branch is unknown', () => {
            expect(validate([], undefined, 'develop').canProceed).toBe(true);
        });
    });

    describe('non-empty list — scope is the configured patterns', () => {
        it('reviews a PR targeting a configured branch', () => {
            expect(validate(['develop'], 'main', 'develop').canProceed).toBe(
                true,
            );
        });

        it('still reviews a PR targeting the default branch', () => {
            expect(validate(['develop'], 'main', 'main').canProceed).toBe(true);
        });

        it('skips a PR targeting a branch outside the patterns', () => {
            expect(validate(['develop'], 'main', 'staging').canProceed).toBe(
                false,
            );
        });

        it('lets an explicit exclusion opt the default branch out', () => {
            expect(
                validate(['develop', '!main'], 'main', 'main').canProceed,
            ).toBe(false);
        });

        it('matches wildcard patterns', () => {
            expect(
                validate(['release/*'], 'main', 'release/2.0').canProceed,
            ).toBe(true);
        });
    });
});

describe('ValidateConfigStage — @kody -v naming no agent', () => {
    let stage: ValidateConfigStage;
    let createSingleIssueComment: jest.Mock;

    const agent = (id: string, name: string, enabled = true) => ({
        id,
        name,
        enabled,
        instructions: '',
        scope: {},
        tools: {},
        presentation: {
            tag: { color: 'blue' },
            format: 'inline',
            suggestedFix: 'when-confident',
        },
    });

    const buildContext = (
        onlyCustomAgent: string | undefined,
        customAgents: unknown[],
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
                number: 7,
                title: 'feat: ledger',
                isDraft: false,
                base: { ref: 'main' },
                head: { ref: 'feature' },
            },
            onlyCustomAgent,
            codeReviewConfig: {
                automatedReviewActive: true,
                ignoredTitleKeywords: [],
                baseBranches: [],
                runOnDraft: true,
                customAgents,
            },
        }) as unknown as CodeReviewPipelineContext;

    beforeEach(async () => {
        createSingleIssueComment = jest.fn().mockResolvedValue({ id: 'c1' });
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ValidateConfigStage,
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: {
                        findLatestExecutionByFilters: jest
                            .fn()
                            .mockResolvedValue(null),
                    },
                },
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: { findByKey: jest.fn().mockResolvedValue(null) },
                },
                {
                    provide: CodeManagementService,
                    useValue: { createSingleIssueComment },
                },
                {
                    provide: LICENSE_SERVICE_TOKEN,
                    useValue: {
                        validateOrganizationLicense: jest
                            .fn()
                            .mockResolvedValue({
                                valid: true,
                                subscriptionStatus: 'active',
                                planType: 'teams_byok',
                            }),
                    },
                },
            ],
        }).compile();
        stage = module.get<ValidateConfigStage>(ValidateConfigStage);
    });

    it('answers on the PR with the agents it has, and skips the review', async () => {
        const result = await stage.execute(
            buildContext('ledgr', [
                agent('1', 'Ledger Rules'),
                agent('2', 'Data Contracts', false),
            ]),
        );

        expect(createSingleIssueComment).toHaveBeenCalledWith(
            expect.objectContaining({
                prNumber: 7,
                body: 'No custom agent named `ledgr` on this repository. Agents: `ledger-rules`, `data-contracts`.',
            }),
        );
        expect(result.statusInfo).toEqual({
            status: 'skipped',
            message: 'No custom agent matches the @kody -v command.',
        });
    });

    it('says so when the repository has no custom agents', async () => {
        await stage.execute(buildContext('ledger', []));

        expect(createSingleIssueComment).toHaveBeenCalledWith(
            expect.objectContaining({
                body: 'No custom agent named `ledger` on this repository. It has no custom agents.',
            }),
        );
    });

    it('runs the review when the slug names an agent, enabled or not', async () => {
        const result = await stage.execute(
            buildContext('data-contracts', [
                agent('2', 'Data Contracts', false),
            ]),
        );

        expect(createSingleIssueComment).not.toHaveBeenCalled();
        expect(result.statusInfo?.status).not.toBe('skipped');
    });

    it('leaves a review without -v alone', async () => {
        await stage.execute(buildContext(undefined, []));

        expect(createSingleIssueComment).not.toHaveBeenCalled();
    });
});

describe('ValidateConfigStage — custom agents plan gate', () => {
    let stage: ValidateConfigStage;
    let createSingleIssueComment: jest.Mock;
    let validateOrganizationLicense: jest.Mock;

    const agent = {
        id: 'a1',
        name: 'Ledger Rules',
        enabled: true,
        instructions: '',
        scope: { include: ['package.json'] },
        tools: {},
        presentation: {
            tag: { color: 'blue' },
            format: 'inline',
            suggestedFix: 'when-confident',
        },
    };
    const knowledge = [
        { id: 'k1', kind: 'doc', path: 'docs/ledger.md', linkedTo: ['main'] },
    ];

    const FREE = {
        valid: true,
        subscriptionStatus: 'active',
        planType: 'free_byok',
    };
    const TEAMS = {
        valid: true,
        subscriptionStatus: 'active',
        planType: 'teams_byok',
    };
    const TRIAL = {
        valid: true,
        subscriptionStatus: 'trial',
        planType: 'teams_managed',
    };

    const buildContext = (
        onlyCustomAgent?: string,
        customAgents: unknown[] = [agent],
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
                number: 7,
                title: 'feat: ledger',
                isDraft: false,
                base: { ref: 'main' },
                head: { ref: 'feature' },
            },
            onlyCustomAgent,
            codeReviewConfig: {
                automatedReviewActive: true,
                ignoredTitleKeywords: [],
                baseBranches: [],
                runOnDraft: true,
                customAgents,
                knowledge,
            },
        }) as unknown as CodeReviewPipelineContext;

    beforeEach(async () => {
        createSingleIssueComment = jest.fn().mockResolvedValue({ id: 'c1' });
        validateOrganizationLicense = jest.fn();
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ValidateConfigStage,
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: {
                        findLatestExecutionByFilters: jest
                            .fn()
                            .mockResolvedValue(null),
                    },
                },
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: { findByKey: jest.fn().mockResolvedValue(null) },
                },
                {
                    provide: CodeManagementService,
                    useValue: { createSingleIssueComment },
                },
                {
                    provide: LICENSE_SERVICE_TOKEN,
                    useValue: { validateOrganizationLicense },
                },
            ],
        }).compile();
        stage = module.get<ValidateConfigStage>(ValidateConfigStage);
    });

    it('on free, reviews without the custom agents and their skills and docs, keeping nothing to rescue', async () => {
        validateOrganizationLicense.mockResolvedValue(FREE);

        const result = await stage.execute(buildContext());

        expect(result.codeReviewConfig.customAgents).toEqual([]);
        expect(result.codeReviewConfig.knowledge).toEqual([]);
        expect(
            ignoredFilesForCustomAgents(result, [
                { filename: 'package.json' } as any,
            ]),
        ).toEqual([]);
        expect(result.statusInfo?.status).not.toBe('skipped');
        expect(createSingleIssueComment).not.toHaveBeenCalled();
    });

    it('on free, answers @kody -v with the plan and skips the review', async () => {
        validateOrganizationLicense.mockResolvedValue(FREE);

        const result = await stage.execute(buildContext('ledger-rules'));

        expect(createSingleIssueComment).toHaveBeenCalledWith(
            expect.objectContaining({
                prNumber: 7,
                body: `\`@kody -v ledger-rules\` did not run. ${CUSTOM_AGENTS_PLAN_REQUIRED}`,
            }),
        );
        expect(result.statusInfo).toEqual({
            status: 'skipped',
            message: "Custom agents are not on this organization's plan.",
        });
    });

    it.each([
        ['Teams', TEAMS],
        ['trial', TRIAL],
    ])(
        'on %s, keeps the custom agents and runs @kody -v',
        async (_, license) => {
            validateOrganizationLicense.mockResolvedValue(license);

            const result = await stage.execute(buildContext('ledger-rules'));

            expect(result.codeReviewConfig.customAgents).toEqual([agent]);
            expect(result.codeReviewConfig.knowledge).toEqual(knowledge);
            expect(createSingleIssueComment).not.toHaveBeenCalled();
            expect(result.statusInfo?.status).not.toBe('skipped');
        },
    );

    it('fails closed when the license cannot be read', async () => {
        validateOrganizationLicense.mockRejectedValue(
            new Error('billing down'),
        );

        const result = await stage.execute(buildContext());

        expect(result.codeReviewConfig.customAgents).toEqual([]);
        expect(result.codeReviewConfig.knowledge).toEqual([]);
    });

    it('does not read the license for a review with no custom agents', async () => {
        const context = buildContext(undefined, []);
        (context.codeReviewConfig as any).knowledge = [];

        await stage.execute(context);

        expect(validateOrganizationLicense).not.toHaveBeenCalled();
    });
});
