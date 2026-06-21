import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesValidationService } from '@libs/ee/kodyRules/service/kody-rules-validation.service';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import {
    IKodyRule,
    IKodyRuleMemory,
    IKodyRules,
    KodyRuleRequestType,
    KodyRulesOrigin,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('KodyRulesService.createOrUpdateMemory', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const buildExpectedMemoryLink = (
        scope: string,
        ruleId?: string,
        teamId?: string,
    ) => {
        const baseUrl = (process.env.API_USER_INVITE_BASE_URL || '').replace(
            /\/$/,
            '',
        );

        if (!baseUrl) {
            return '';
        }

        const url = new URL(baseUrl);

        if (!ruleId) {
            url.pathname = `/settings/code-review/${scope}/kody-rules`;
            url.searchParams.set('tab', 'memories');
            return url.toString();
        }

        url.pathname = `/settings/code-review/${scope}/kody-rules/${ruleId}`;
        url.searchParams.set('tab', 'memories');

        if (teamId) {
            url.searchParams.set('teamId', teamId);
        }

        return url.toString();
    };

    const existingMemory: Partial<IKodyRule> = {
        uuid: 'existing-memory-1',
        type: KodyRulesType.MEMORY,
        status: KodyRulesStatus.ACTIVE,
        origin: KodyRulesOrigin.GENERATED,
        title: 'Use strict typing',
        rule: 'Always use explicit types in public APIs',
        repositoryId: 'repo-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const createGeneratedMemory = (
        overrides: Partial<IKodyRuleMemory> = {},
    ): IKodyRuleMemory => ({
        type: KodyRulesType.MEMORY,
        title: 'Use strict typing',
        rule: 'Always use explicit types in public APIs',
        repositoryId: 'repo-1',
        status: KodyRulesStatus.ACTIVE,
        origin: KodyRulesOrigin.GENERATED,
        directoryId: undefined,
        path: undefined,
        ...overrides,
    });

    const setup = ({
        llmResult,
        currentMemory = existingMemory,
        requireApproval = false,
    }: {
        llmResult: any;
        currentMemory?: Partial<IKodyRule>;
        requireApproval?: boolean;
    }) => {
        const repositoryMock = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ rules: [currentMemory] } as IKodyRules),
        };

        const observabilityServiceMock = {
            runLLMInSpan: jest.fn().mockResolvedValue({ result: llmResult }),
        };

        const permissionValidationServiceMock = {
            getBYOKConfig: jest.fn().mockResolvedValue(undefined),
        };

        const codeBaseConfigServiceMock = {
            getSimpleConfig: jest.fn().mockResolvedValue({
                llmGeneratedMemoriesRequireApproval: requireApproval,
            }),
        };

        const centralizedConfigPrServiceMock = {
            createMutationPullRequestIfEnabled: jest.fn().mockResolvedValue({
                mode: 'disabled',
            }),
            resolveRepositoryFolderName: jest
                .fn()
                .mockResolvedValue('repo-1-name'),
            resolveDirectoryGroupFolderName: jest.fn().mockResolvedValue(null),
            sanitizeFileName: jest.fn().mockReturnValue('memory-rule'),
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(
                    ({ repositoryFolder, relativePath }) =>
                        `${repositoryFolder}/${relativePath}`,
                ),
        };

        const validationService = new KodyRulesValidationService({} as any);

        const moduleRefMock = {
            resolve: jest
                .fn()
                .mockResolvedValue(centralizedConfigPrServiceMock),
        };

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            validationService,
            {} as any,
            {} as any,
            observabilityServiceMock as any,
            permissionValidationServiceMock as any,
            moduleRefMock as any,
            codeBaseConfigServiceMock as any,
        );

        return {
            service,
            repositoryMock,
            observabilityServiceMock,
            centralizedConfigPrServiceMock,
        };
    };

    it('skips creation when LLM indicates duplicate generated memory', async () => {
        const { service, observabilityServiceMock } = setup({
            llmResult: {
                action: 'skip',
                targetMemoryUuid: 'existing-memory-1',
            },
        });

        const createOrUpdateSpy = jest
            .spyOn(service, 'createOrUpdate')
            .mockResolvedValue(null);

        const result = await service.createOrUpdateMemory(
            organizationAndTeamData,
            createGeneratedMemory(),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(result).toEqual({
            rule: existingMemory,
            action: 'skipped',
            requiresApproval: false,
            link: buildExpectedMemoryLink(
                'repo-1',
                'existing-memory-1',
                'team-1',
            ),
        });
        expect(createOrUpdateSpy).not.toHaveBeenCalled();
        expect(observabilityServiceMock.runLLMInSpan).toHaveBeenCalledTimes(1);
    });

    it('updates existing memory when LLM indicates refinement', async () => {
        const { service } = setup({
            llmResult: {
                action: 'update',
                targetMemoryUuid: 'existing-memory-1',
                updatedTitle: 'Prefer strict typing',
                updatedRule:
                    'Use explicit types on exported functions and public APIs',
            },
        });

        const updatedResult = {
            uuid: 'existing-memory-1',
            title: 'Prefer strict typing',
            rule: 'Use explicit types on exported functions and public APIs',
        } as Partial<IKodyRule>;

        const createOrUpdateSpy = jest
            .spyOn(service, 'createOrUpdate')
            .mockResolvedValue(updatedResult as any);

        const result = await service.createOrUpdateMemory(
            organizationAndTeamData,
            createGeneratedMemory(),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(createOrUpdateSpy).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                uuid: 'existing-memory-1',
                title: 'Prefer strict typing',
                rule: 'Use explicit types on exported functions and public APIs',
                severity: 'medium',
                origin: KodyRulesOrigin.GENERATED,
            }),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );
        expect(result).toEqual({
            rule: updatedResult,
            action: 'updated',
            requiresApproval: false,
            link: buildExpectedMemoryLink(
                'global',
                'existing-memory-1',
                'team-1',
            ),
        });
    });

    it('creates pending memory when generated memory requires approval and has no uuid', async () => {
        const { service } = setup({
            llmResult: {
                action: 'create',
            },
            currentMemory: undefined,
            requireApproval: true,
        });

        const pendingCreate = {
            uuid: 'pending-create-1',
            status: KodyRulesStatus.PENDING,
            requestType: KodyRuleRequestType.MEMORY_CREATE,
        } as Partial<IKodyRule>;

        const createOrUpdateSpy = jest
            .spyOn(service, 'createOrUpdate')
            .mockResolvedValue(pendingCreate as any);

        const result = await service.createOrUpdateMemory(
            organizationAndTeamData,
            createGeneratedMemory(),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(createOrUpdateSpy).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                uuid: undefined,
                status: KodyRulesStatus.PENDING,
                requestType: KodyRuleRequestType.MEMORY_CREATE,
            }),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );
        expect(result).toEqual({
            rule: pendingCreate,
            action: 'created',
            requiresApproval: true,
            link: buildExpectedMemoryLink('global'),
        });
    });

    it('returns null when createOrUpdate returns null on create path', async () => {
        const { service } = setup({
            llmResult: {
                action: 'create',
            },
        });

        jest.spyOn(service, 'createOrUpdate').mockResolvedValue(null);

        const result = await service.createOrUpdateMemory(
            organizationAndTeamData,
            createGeneratedMemory(),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(result).toBeNull();
    });

    it('creates pending update request when target memory was user-created', async () => {
        const { service } = setup({
            llmResult: {
                action: 'update',
                targetMemoryUuid: 'existing-memory-1',
                updatedTitle: 'Prefer strict typing',
                updatedRule:
                    'Use explicit types on exported functions and public APIs',
            },
            currentMemory: {
                ...existingMemory,
                origin: KodyRulesOrigin.USER,
            },
            requireApproval: false,
        });

        const pendingRequest = {
            uuid: 'pending-update-1',
            status: KodyRulesStatus.PENDING,
            requestType: KodyRuleRequestType.MEMORY_UPDATE,
            targetRuleUuid: 'existing-memory-1',
        } as Partial<IKodyRule>;

        const createOrUpdateSpy = jest
            .spyOn(service, 'createOrUpdate')
            .mockResolvedValue(pendingRequest as any);

        const result = await service.createOrUpdateMemory(
            organizationAndTeamData,
            createGeneratedMemory(),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(createOrUpdateSpy).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                uuid: undefined,
                status: KodyRulesStatus.PENDING,
                requestType: KodyRuleRequestType.MEMORY_UPDATE,
                targetRuleUuid: 'existing-memory-1',
            }),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );
        expect(result).toEqual({
            rule: pendingRequest,
            action: 'created',
            requiresApproval: true,
            link: buildExpectedMemoryLink('global'),
        });
    });

    it('creates pending update request when generated target requires approval', async () => {
        const { service } = setup({
            llmResult: {
                action: 'update',
                targetMemoryUuid: 'existing-memory-1',
            },
            currentMemory: {
                ...existingMemory,
                origin: KodyRulesOrigin.GENERATED,
            },
            requireApproval: true,
        });

        const pendingRequest = {
            uuid: 'pending-update-2',
            status: KodyRulesStatus.PENDING,
            requestType: KodyRuleRequestType.MEMORY_UPDATE,
            targetRuleUuid: 'existing-memory-1',
        } as Partial<IKodyRule>;

        const createOrUpdateSpy = jest
            .spyOn(service, 'createOrUpdate')
            .mockResolvedValue(pendingRequest as any);

        const result = await service.createOrUpdateMemory(
            organizationAndTeamData,
            createGeneratedMemory(),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(createOrUpdateSpy).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                uuid: undefined,
                status: KodyRulesStatus.PENDING,
                requestType: KodyRuleRequestType.MEMORY_UPDATE,
                targetRuleUuid: 'existing-memory-1',
            }),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );
        expect(result).toEqual({
            rule: pendingRequest,
            action: 'created',
            requiresApproval: true,
            link: buildExpectedMemoryLink('global'),
        });
    });

    it('creates pending creation request with requestType when generated memory needs approval', async () => {
        const { service } = setup({
            llmResult: {
                action: 'create',
            },
            requireApproval: true,
        });

        const pendingRequest = {
            uuid: 'pending-create-1',
            status: KodyRulesStatus.PENDING,
            requestType: KodyRuleRequestType.MEMORY_CREATE,
        } as Partial<IKodyRule>;

        const createOrUpdateSpy = jest
            .spyOn(service, 'createOrUpdate')
            .mockResolvedValue(pendingRequest as any);

        const result = await service.createOrUpdateMemory(
            organizationAndTeamData,
            createGeneratedMemory(),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(createOrUpdateSpy).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                uuid: undefined,
                status: KodyRulesStatus.PENDING,
                requestType: KodyRuleRequestType.MEMORY_CREATE,
                targetRuleUuid: undefined,
            }),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(result).toEqual({
            rule: pendingRequest,
            action: 'created',
            requiresApproval: true,
            link: buildExpectedMemoryLink('global'),
        });
    });

    it('bypasses LLM resolution for non-generated memories', async () => {
        const { service, observabilityServiceMock } = setup({
            llmResult: {
                action: 'skip',
                targetMemoryUuid: 'existing-memory-1',
            },
        });

        const persistedResult = {
            uuid: 'new-memory',
            title: 'Team preference',
            rule: 'Prefer compact examples',
        } as Partial<IKodyRule>;

        const createOrUpdateSpy = jest
            .spyOn(service, 'createOrUpdate')
            .mockResolvedValue(persistedResult as any);

        const result = await service.createOrUpdateMemory(
            organizationAndTeamData,
            createGeneratedMemory({
                title: 'Team preference',
                rule: 'Prefer compact examples',
                origin: KodyRulesOrigin.USER,
            }),
            { userId: 'user-1', userEmail: 'user@kodus.io' },
        );

        expect(observabilityServiceMock.runLLMInSpan).not.toHaveBeenCalled();
        expect(createOrUpdateSpy).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            rule: persistedResult,
            action: 'created',
            requiresApproval: false,
            link: buildExpectedMemoryLink('global', 'new-memory', 'team-1'),
        });
    });

    it('creates centralized PR and persists pending_add snapshot for memory create', async () => {
        const { service, centralizedConfigPrServiceMock } = setup({
            llmResult: {
                action: 'create',
            },
            currentMemory: undefined,
            requireApproval: false,
        });

        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            {
                mode: 'centralized-pr',
                prUrl: 'https://example.com/pr/101',
                message: 'PR opened',
            },
        );

        const createOrUpdateSpy = jest
            .spyOn(service, 'createOrUpdate')
            .mockResolvedValue({
                uuid: 'memory-1',
                repositoryId: 'repo-1',
                status: KodyRulesStatus.ACTIVE,
                centralizedConfig: {
                    path: 'repo-1-name/.kody-rules/memories/memory-rule.yml',
                    status: 'pending_add',
                },
            } as any);

        const result = await service.createOrUpdateMemory(
            organizationAndTeamData,
            createGeneratedMemory({
                title: 'Persist integration preferences',
                rule: 'Store integration setup details for next runs',
            }),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(createOrUpdateSpy).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                type: KodyRulesType.MEMORY,
                centralizedConfig: expect.objectContaining({
                    status: 'pending_add',
                }),
            }),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(result).toEqual(
            expect.objectContaining({
                action: 'created',
                link: 'https://example.com/pr/101',
            }),
        );
    });

    it('creates centralized PR and persists pending_edit snapshot for memory update', async () => {
        const { service, centralizedConfigPrServiceMock } = setup({
            llmResult: {
                action: 'update',
                targetMemoryUuid: 'existing-memory-1',
                updatedTitle: 'Refine strict typing guidance',
                updatedRule: 'Prefer explicit types for exported APIs',
            },
            requireApproval: false,
        });

        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            {
                mode: 'centralized-pr',
                prUrl: 'https://example.com/pr/102',
                message: 'PR opened',
            },
        );

        const createOrUpdateSpy = jest
            .spyOn(service, 'createOrUpdate')
            .mockResolvedValue({
                uuid: 'existing-memory-1',
                repositoryId: 'repo-1',
                status: KodyRulesStatus.ACTIVE,
                centralizedConfig: {
                    path: 'repo-1-name/.kody-rules/memories/memory-rule.yml',
                    status: 'pending_edit',
                },
            } as any);

        const result = await service.createOrUpdateMemory(
            organizationAndTeamData,
            createGeneratedMemory(),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(createOrUpdateSpy).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                uuid: 'existing-memory-1',
                type: KodyRulesType.MEMORY,
                centralizedConfig: expect.objectContaining({
                    status: 'pending_edit',
                }),
            }),
            { userId: 'kody', userEmail: 'kody@kodus.io' },
        );

        expect(result).toEqual(
            expect.objectContaining({
                action: 'updated',
                link: 'https://example.com/pr/102',
            }),
        );
    });

    it('applies pending memory update request into target memory on approval', async () => {
        const pendingRequestRule: Partial<IKodyRule> = {
            uuid: 'pending-request-1',
            type: KodyRulesType.MEMORY,
            status: KodyRulesStatus.PENDING,
            requestType: KodyRuleRequestType.MEMORY_UPDATE,
            targetRuleUuid: 'existing-memory-1',
            title: 'Prefer strict typing',
            rule: 'Use explicit types on exported functions and public APIs',
            repositoryId: 'repo-1',
            origin: KodyRulesOrigin.GENERATED,
        };

        const targetMemoryRule: Partial<IKodyRule> = {
            ...existingMemory,
            uuid: 'existing-memory-1',
            status: KodyRulesStatus.ACTIVE,
            origin: KodyRulesOrigin.USER,
        };

        const repositoryMock = {
            findByOrganizationId: jest.fn().mockResolvedValue({
                uuid: 'doc-1',
                rules: [targetMemoryRule, pendingRequestRule],
            } as IKodyRules),
            updateRule: jest
                .fn()
                .mockResolvedValueOnce({
                    rules: [
                        {
                            ...targetMemoryRule,
                            title: pendingRequestRule.title,
                            rule: pendingRequestRule.rule,
                        },
                        pendingRequestRule,
                    ],
                })
                .mockResolvedValueOnce({
                    rules: [
                        {
                            ...targetMemoryRule,
                            title: pendingRequestRule.title,
                            rule: pendingRequestRule.rule,
                        },
                        {
                            ...pendingRequestRule,
                            status: KodyRulesStatus.DELETED,
                        },
                    ],
                }),
        };

        const ccpMock = {
            createMutationPullRequestIfEnabled: jest.fn().mockResolvedValue({
                mode: 'disabled',
            }),
            resolveRepositoryFolderName: jest.fn(),
            sanitizeFileName: jest.fn(),
            buildCentralizedPath: jest.fn(),
        };

        const permissionValidationServiceMock = {
            shouldLimitResources: jest.fn().mockResolvedValue(false),
        };

        const validationService = new KodyRulesValidationService(
            permissionValidationServiceMock as any,
        );

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            validationService,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            { resolve: jest.fn().mockResolvedValue(ccpMock) } as any,
            {} as any,
        );

        const result = await service.createOrUpdate(
            organizationAndTeamData,
            {
                ...(pendingRequestRule as any),
                status: KodyRulesStatus.ACTIVE,
                severity: 'medium',
            },
            { userId: 'approver-1', userEmail: 'approver@kodus.io' },
        );

        expect(repositoryMock.updateRule).toHaveBeenCalledTimes(1);
        expect(repositoryMock.updateRule).toHaveBeenNthCalledWith(
            1,
            'doc-1',
            'pending-request-1',
            expect.objectContaining({
                title: 'Prefer strict typing',
                rule: 'Use explicit types on exported functions and public APIs',
                status: KodyRulesStatus.ACTIVE,
            }),
        );
        expect(result).toEqual(
            expect.objectContaining({
                uuid: 'pending-request-1',
                title: 'Prefer strict typing',
                status: KodyRulesStatus.PENDING,
            }),
        );
    });
});
