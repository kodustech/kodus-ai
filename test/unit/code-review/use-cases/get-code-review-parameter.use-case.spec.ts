import { Test, TestingModule } from '@nestjs/testing';
import { GetCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/get-code-review-parameter.use-case';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CODE_BASE_CONFIG_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN } from '@libs/ai-engine/domain/prompt/contracts/promptExternalReferenceManager.contract';
import { KodusConfigFileOverlayStatus } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';

describe('GetCodeReviewParameterUseCase', () => {
    let useCase: GetCodeReviewParameterUseCase;
    let mockParametersService: any;
    let mockCodeBaseConfigService: any;
    let mockAuthorizationService: any;
    let mockPromptReferenceManager: any;

    const buildParameters = (overridesWebPreferences: boolean) => ({
        toObject: () => ({
            createdAt: new Date('2025-09-10T00:00:00.000Z'),
            configValue: {
                configs: {},
                repositories: [
                    {
                        id: 'repo-1',
                        name: 'repo-1',
                        configs: {
                            kodusConfigFileOverridesWebPreferences:
                                overridesWebPreferences,
                        },
                        directories: [
                            { id: 'dir-broken', path: 'broken/path', configs: {} },
                            { id: 'dir-ok', path: 'ok/path', configs: {} },
                        ],
                    },
                ],
            },
        }),
    });

    const execute = (options?: { includeFileOverlay?: boolean }) =>
        useCase.execute(
            { organization: { uuid: 'org-1' } } as any,
            'team-1',
            options,
        );

    beforeEach(async () => {
        mockParametersService = {
            findByKey: jest.fn(),
        };

        mockCodeBaseConfigService = {
            getKodusConfigFile: jest.fn(),
            getDefaultBranch: jest.fn().mockResolvedValue('main'),
        };

        mockAuthorizationService = {
            check: jest.fn().mockResolvedValue(true),
        };

        mockPromptReferenceManager = {
            buildConfigKey: jest.fn().mockReturnValue('config-key'),
            getReference: jest.fn().mockResolvedValue(null),
            getMultipleReferences: jest.fn().mockResolvedValue(new Map()),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GetCodeReviewParameterUseCase,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: mockParametersService,
                },
                {
                    provide: CODE_BASE_CONFIG_SERVICE_TOKEN,
                    useValue: mockCodeBaseConfigService,
                },
                {
                    provide: AuthorizationService,
                    useValue: mockAuthorizationService,
                },
                {
                    provide: PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN,
                    useValue: mockPromptReferenceManager,
                },
            ],
        }).compile();

        useCase = module.get<GetCodeReviewParameterUseCase>(
            GetCodeReviewParameterUseCase,
        );
    });

    it('keeps a directory whose config file cannot be read, flagged as unavailable', async () => {
        mockParametersService.findByKey.mockResolvedValue(buildParameters(true));
        mockCodeBaseConfigService.getKodusConfigFile.mockImplementation(
            async ({ directoryPath }: { directoryPath?: string }) => {
                if (directoryPath === 'broken/path') {
                    throw new Error('directory config failed');
                }
                return {};
            },
        );

        const result = await execute();

        const [repository] = result.configValue.repositories;
        expect(result.configValue.repositories).toHaveLength(1);
        expect(repository.kodusConfigFile.status).toBe(
            KodusConfigFileOverlayStatus.LOADED,
        );

        // Dropping the directory would hide it from the settings screen; it
        // renders from stored config with the overlay flagged as missing.
        expect(repository.directories).toHaveLength(2);
        expect(
            repository.directories.find((dir) => dir.id === 'dir-broken')
                .kodusConfigFile,
        ).toEqual({
            status: KodusConfigFileOverlayStatus.UNAVAILABLE,
            error: 'directory config failed',
        });
        expect(
            repository.directories.find((dir) => dir.id === 'dir-ok')
                .kodusConfigFile.status,
        ).toBe(KodusConfigFileOverlayStatus.LOADED);
    });

    it('resolves the default branch once per repository and reuses it', async () => {
        mockParametersService.findByKey.mockResolvedValue(buildParameters(true));
        mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue({});

        await execute();

        expect(mockCodeBaseConfigService.getDefaultBranch).toHaveBeenCalledTimes(
            1,
        );
        expect(
            mockCodeBaseConfigService.getKodusConfigFile.mock.calls,
        ).toHaveLength(3);
        for (const [params] of mockCodeBaseConfigService.getKodusConfigFile.mock
            .calls) {
            expect(params.defaultBranch).toBe('main');
        }
    });

    it('reports an empty read as not found rather than loaded', async () => {
        mockParametersService.findByKey.mockResolvedValue(buildParameters(true));
        // getKodusConfigFile returns undefined both for a repository with no
        // file and for a provider error an adapter swallowed.
        mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue(
            undefined,
        );

        const result = await execute();

        expect(result.configValue.repositories[0].kodusConfigFile.status).toBe(
            KodusConfigFileOverlayStatus.NOT_FOUND,
        );
    });

    it('still reads the file when the adapter reports an empty default branch', async () => {
        mockParametersService.findByKey.mockResolvedValue(buildParameters(true));
        // Bitbucket's getDefaultBranch catches and returns '' instead of
        // throwing; getKodusConfigFile resolves the branch itself in that case.
        mockCodeBaseConfigService.getDefaultBranch.mockResolvedValue('');
        mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue({
            reviewOptions: { bug: true },
        });

        const result = await execute();

        expect(result.configValue.repositories[0].kodusConfigFile.status).toBe(
            KodusConfigFileOverlayStatus.LOADED,
        );
        expect(mockCodeBaseConfigService.getKodusConfigFile).toHaveBeenCalled();
    });

    it('does not leave a floating rejection when the budget is already spent', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);

        const useCaseClass = GetCodeReviewParameterUseCase as any;
        const originalTimeout = useCaseClass.FILE_OVERLAY_TIMEOUT_MS;
        // A zero budget makes every provider call take the exhausted path, so
        // the case is deterministic instead of a race against the real 8s.
        useCaseClass.FILE_OVERLAY_TIMEOUT_MS = 0;

        mockParametersService.findByKey.mockResolvedValue(buildParameters(true));

        try {
            const result = await execute();
            // Node reports unhandled rejections a macrotask later.
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(result.configValue.repositories[0].kodusConfigFile.status).toBe(
                KodusConfigFileOverlayStatus.UNAVAILABLE,
            );
            // Queueing the call and only then bailing would leave its promise
            // with nothing racing it, so its rejection escapes the caller that
            // already handled the missing overlay.
            expect(unhandled).toEqual([]);
        } finally {
            useCaseClass.FILE_OVERLAY_TIMEOUT_MS = originalTimeout;
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('marks every scope as unavailable when the default branch cannot be resolved', async () => {
        mockParametersService.findByKey.mockResolvedValue(buildParameters(true));
        mockCodeBaseConfigService.getDefaultBranch.mockRejectedValue(
            new Error('provider unreachable'),
        );

        const result = await execute();

        const [repository] = result.configValue.repositories;
        expect(repository.kodusConfigFile).toEqual({
            status: KodusConfigFileOverlayStatus.UNAVAILABLE,
            error: 'provider unreachable',
        });
        expect(repository.directories).toHaveLength(2);
        expect(
            mockCodeBaseConfigService.getKodusConfigFile,
        ).not.toHaveBeenCalled();
    });

    it('caps how many provider reads run at once', async () => {
        const repositories = Array.from({ length: 10 }, (_, index) => ({
            id: `repo-${index}`,
            name: `repo-${index}`,
            configs: { kodusConfigFileOverridesWebPreferences: true },
            directories: [],
        }));

        mockParametersService.findByKey.mockResolvedValue({
            toObject: () => ({
                createdAt: new Date('2025-09-10T00:00:00.000Z'),
                configValue: { configs: {}, repositories },
            }),
        });

        let inFlight = 0;
        let peakInFlight = 0;
        const trackConcurrency = async () => {
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
        };

        mockCodeBaseConfigService.getDefaultBranch.mockImplementation(
            async () => {
                await trackConcurrency();
                return 'main';
            },
        );
        mockCodeBaseConfigService.getKodusConfigFile.mockImplementation(
            async () => {
                await trackConcurrency();
                return {};
            },
        );

        const result = await execute();

        expect(result.configValue.repositories).toHaveLength(10);
        // Providers without a rate gate (GitHub, GitLab, Azure) would otherwise
        // see one connection per repository open at the same instant.
        expect(peakInFlight).toBeLessThanOrEqual(4);
    });

    it('does not touch the provider when the override flag is off', async () => {
        mockParametersService.findByKey.mockResolvedValue(
            buildParameters(false),
        );

        const result = await execute();

        const [repository] = result.configValue.repositories;
        expect(repository.kodusConfigFile.status).toBe(
            KodusConfigFileOverlayStatus.DISABLED,
        );
        expect(
            mockCodeBaseConfigService.getDefaultBranch,
        ).not.toHaveBeenCalled();
        expect(
            mockCodeBaseConfigService.getKodusConfigFile,
        ).not.toHaveBeenCalled();
    });

    it('skips the overlay entirely when the caller opts out', async () => {
        mockParametersService.findByKey.mockResolvedValue(buildParameters(true));

        const result = await execute({ includeFileOverlay: false });

        const [repository] = result.configValue.repositories;
        expect(repository.kodusConfigFile.status).toBe(
            KodusConfigFileOverlayStatus.SKIPPED,
        );
        expect(
            mockCodeBaseConfigService.getDefaultBranch,
        ).not.toHaveBeenCalled();
        expect(
            mockCodeBaseConfigService.getKodusConfigFile,
        ).not.toHaveBeenCalled();
    });
});
