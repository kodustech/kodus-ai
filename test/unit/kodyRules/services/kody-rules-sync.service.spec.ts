import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('KodyRulesSyncService.syncRepositoryMain', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const repository = {
        id: 'repo-1',
        name: 'backend-services',
        fullName: 'quintoandar/backend-services',
        defaultBranch: 'main',
    };

    function createService() {
        const kodyRulesService = {
            createOrUpdate: jest.fn().mockResolvedValue({ uuid: 'rule-1' }),
        };
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [
                        {
                            id: 'repo-1',
                            configs: { ideRulesSyncEnabled: false },
                            directories: [
                                {
                                    id: 'dir-1',
                                    path: 'qantilever',
                                },
                            ],
                        },
                    ],
                },
            }),
        };
        const contextResolutionService = {
            getRepositoryNameByOrganizationAndRepository:
                jest.fn().mockResolvedValue('backend-services'),
            getTeamIdByOrganizationAndRepository:
                jest.fn().mockResolvedValue('team-1'),
        };
        const codeManagementService = {
            getDefaultBranch: jest.fn().mockResolvedValue('main'),
            getRepositoryAllFiles: jest.fn(),
            getRepositoryContentFile: jest
                .fn()
                .mockResolvedValue({
                    data: {
                        content: Buffer.from(
                            [
                                '---',
                                '# @kody-sync',
                                '---',
                                'Logging rule content',
                            ].join('\n'),
                            'utf-8',
                        ).toString('base64'),
                        encoding: 'base64',
                    },
                }),
        };
        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        const promptRunnerService = {};
        const permissionValidationService = {
            validateBasicLicense: jest.fn().mockResolvedValue({ allowed: true }),
            getBYOKConfig: jest.fn().mockResolvedValue(undefined),
        };
        const observabilityService = {};
        const contextReferenceDetectionService = {};

        const service = new KodyRulesSyncService(
            kodyRulesService as any,
            parametersService as any,
            contextResolutionService as any,
            codeManagementService as any,
            updateOrCreateCodeReviewParameterUseCase as any,
            promptRunnerService as any,
            permissionValidationService as any,
            observabilityService as any,
            contextReferenceDetectionService as any,
        );

        jest.spyOn(service as any, 'convertFileToKodyRules').mockResolvedValue([
            {
                title: 'Logging Rule',
                rule: 'Use log instead of logger',
                path: '**/*',
                severity: 'medium',
                scope: 'file',
                examples: [],
            },
        ]);
        jest.spyOn(service as any, 'processContextReferences').mockResolvedValue(
            undefined,
        );

        return {
            service,
            kodyRulesService,
            codeManagementService,
        };
    }

    it('syncs only the requested path during manual resync', async () => {
        const { service, kodyRulesService, codeManagementService } =
            createService();

        await service.syncRepositoryMain({
            organizationAndTeamData,
            repository,
            path: 'qantilever/.cursor/rules/logging.mdc',
        });

        expect(codeManagementService.getRepositoryAllFiles).not.toHaveBeenCalled();
        expect(codeManagementService.getRepositoryContentFile).toHaveBeenCalledWith(
            expect.objectContaining({
                file: { filename: 'qantilever/.cursor/rules/logging.mdc' },
            }),
        );
        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                sourcePath: 'qantilever/.cursor/rules/logging.mdc',
            }),
            expect.any(Object),
        );
    });
});
