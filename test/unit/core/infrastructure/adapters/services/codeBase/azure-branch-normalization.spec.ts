import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { ValidateConfigStage } from '@libs/code-review/pipeline/stages/validate-config.stage';
import { PlatformType } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { Test, TestingModule } from '@nestjs/testing';

describe('Azure Branch Normalization', () => {
    let validateConfigStage: ValidateConfigStage;

    const mockAutomationExecutionService = {
        findLatestExecutionByFilters: jest.fn(),
        findByPeriodAndTeamAutomationId: jest.fn(),
    };

    const mockOrganizationParametersService = {
        findByKey: jest.fn(),
    };

    const mockCodeManagementService = {
        createSingleIssueComment: jest.fn(),
    };

    const _mockLogger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };

    beforeEach(async () => {
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

        validateConfigStage =
            module.get<ValidateConfigStage>(ValidateConfigStage);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('normalizeBranchesForPlatform', () => {
        it('should normalize patterns for Azure DevOps', () => {
            const branches = ['develop', 'feature/*', 'release/*'];

            const result = (
                validateConfigStage as any
            ).normalizeBranchesForPlatform(branches, PlatformType.AZURE_REPOS);

            expect(result).toEqual([
                'refs/heads/develop',
                'refs/heads/feature/*',
                'refs/heads/release/*',
            ]);
        });

        it('should not normalize for GitHub', () => {
            const branches = ['develop', 'feature/*', 'release/*'];

            const result = (
                validateConfigStage as any
            ).normalizeBranchesForPlatform(branches, PlatformType.GITHUB);

            expect(result).toEqual(['develop', 'feature/*', 'release/*']);
        });

        it('should not normalize for GitLab', () => {
            const branches = ['develop', 'feature/*', 'release/*'];

            const result = (
                validateConfigStage as any
            ).normalizeBranchesForPlatform(branches, PlatformType.GITLAB);

            expect(result).toEqual(['develop', 'feature/*', 'release/*']);
        });

        it('should preserve already normalized patterns for Azure', () => {
            const branches = [
                'refs/heads/develop',
                'feature/*',
                'refs/heads/release/*',
            ];

            const result = (
                validateConfigStage as any
            ).normalizeBranchesForPlatform(branches, PlatformType.AZURE_REPOS);

            expect(result).toEqual([
                'refs/heads/develop', // Already normalized
                'refs/heads/feature/*', // Gets normalized
                'refs/heads/release/*', // Already normalized
            ]);
        });

        it('should handle exclusion patterns correctly for Azure', () => {
            const branches = ['develop', '!main', 'feature/*', '!hotfix/*'];

            const result = (
                validateConfigStage as any
            ).normalizeBranchesForPlatform(branches, PlatformType.AZURE_REPOS);

            expect(result).toEqual([
                'refs/heads/develop',
                '!refs/heads/main', // Exclusion with prefix
                'refs/heads/feature/*',
                '!refs/heads/hotfix/*', // Exclusion pattern with wildcard
            ]);
        });

        it('should preserve already normalized exclusion patterns for Azure', () => {
            const branches = ['!refs/heads/main', '!hotfix/*'];

            const result = (
                validateConfigStage as any
            ).normalizeBranchesForPlatform(branches, PlatformType.AZURE_REPOS);

            expect(result).toEqual([
                '!refs/heads/main', // Already normalized - no change
                '!refs/heads/hotfix/*', // Gets normalized
            ]);
        });

        it('should handle exact match patterns correctly for Azure', () => {
            const branches = ['=develop', 'feature/*', '=main'];

            const result = (
                validateConfigStage as any
            ).normalizeBranchesForPlatform(branches, PlatformType.AZURE_REPOS);

            expect(result).toEqual([
                '=refs/heads/develop', // Exact match with prefix
                'refs/heads/feature/*',
                '=refs/heads/main', // Exact match with prefix
            ]);
        });

        it('should preserve already normalized exact match patterns for Azure', () => {
            const branches = ['=refs/heads/main', '=staging'];

            const result = (
                validateConfigStage as any
            ).normalizeBranchesForPlatform(branches, PlatformType.AZURE_REPOS);

            expect(result).toEqual([
                '=refs/heads/main', // Already normalized - no change
                '=refs/heads/staging', // Gets normalized
            ]);
        });

        it('should handle contains patterns correctly for Azure', () => {
            const branches = ['contains:demo', 'feature/*', 'contains:test'];

            const result = (
                validateConfigStage as any
            ).normalizeBranchesForPlatform(branches, PlatformType.AZURE_REPOS);

            expect(result).toEqual([
                'contains:demo', // Contains patterns should not be normalized
                'refs/heads/feature/*',
                'contains:test', // Contains patterns should not be normalized
            ]);
        });

        it('should handle mixed patterns correctly for Azure', () => {
            const branches = [
                'develop',
                'refs/heads/main',
                'feature/*',
                '!hotfix/*',
                '=staging',
                'contains:demo',
                '!refs/heads/production',
            ];

            const result = (
                validateConfigStage as any
            ).normalizeBranchesForPlatform(branches, PlatformType.AZURE_REPOS);

            expect(result).toEqual([
                'refs/heads/develop',
                'refs/heads/main', // Already normalized
                'refs/heads/feature/*',
                '!refs/heads/hotfix/*', // Exclusion with prefix
                '=refs/heads/staging', // Exact match with prefix
                'contains:demo', // Contains - not normalized
                '!refs/heads/production', // Already normalized exclusion
            ]);
        });
    });

    describe('Integration with shouldExecuteReview', () => {
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationName: 'test-org',
            teamName: 'test-team',
        };

        it('should work with Azure DevOps branches after normalization', () => {
            const result = (validateConfigStage as any).shouldExecuteReview(
                'Test PR',
                'refs/heads/feature/PLT-4873', // Target
                'refs/heads/topic/PLT-9221', // Source
                false,
                {
                    automatedReviewActive: true,
                    baseBranches: ['develop', 'feature/*', 'release/*'],
                    runOnDraft: false,
                },
                'webhook',
                PlatformType.AZURE_REPOS,
                organizationAndTeamData,
            );

            // Should return true because feature/* gets normalized to refs/heads/feature/*
            expect(result).toEqual({ canProceed: true });
        });

        it('should work with GitHub branches without normalization', () => {
            const result = (validateConfigStage as any).shouldExecuteReview(
                'Test PR',
                'feature/PLT-4873', // Target (no prefix)
                'topic/PLT-9221', // Source (no prefix)
                false,
                {
                    automatedReviewActive: true,
                    baseBranches: ['develop', 'feature/*', 'release/*'],
                    runOnDraft: false,
                },
                'webhook',
                PlatformType.GITHUB,
                organizationAndTeamData,
            );

            // Should return true because feature/* matches feature/PLT-4873
            expect(result).toEqual({ canProceed: true });
        });

        it('should work with GitLab branches without normalization', () => {
            const result = (validateConfigStage as any).shouldExecuteReview(
                'Test PR',
                'feature/PLT-4873', // Target (no prefix)
                'topic/PLT-9221', // Source (no prefix)
                false,
                {
                    automatedReviewActive: true,
                    baseBranches: ['develop', 'feature/*', 'release/*'],
                    runOnDraft: false,
                },
                'webhook',
                PlatformType.GITLAB,
                organizationAndTeamData,
            );

            // Should return true because feature/* matches feature/PLT-4873
            expect(result).toEqual({ canProceed: true });
        });

        it('should handle mixed Azure patterns (user + already normalized)', () => {
            const result = (validateConfigStage as any).shouldExecuteReview(
                'Test PR',
                'refs/heads/feature/PLT-4873', // Azure target
                'refs/heads/topic/PLT-9221', // Azure source
                false,
                {
                    automatedReviewActive: true,
                    baseBranches: [
                        'develop', // Will be normalized
                        'refs/heads/main', // Already normalized
                        'feature/*', // Will be normalized
                    ],
                    runOnDraft: false,
                },
                'webhook',
                PlatformType.AZURE_REPOS,
                organizationAndTeamData,
            );

            // Should return true because patterns get normalized properly
            expect(result).toEqual({ canProceed: true });
        });
    });
});
