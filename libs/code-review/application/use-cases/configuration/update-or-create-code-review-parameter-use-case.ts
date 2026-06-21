import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
} from '@nestjs/common';

import { produce } from 'immer';
import { v4 as uuidv4 } from 'uuid';

import { createLogger } from '@kodus/flow';
import {
    CentralizedConfigPrService,
    CentralizedPrMetadata,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import {
    IPromptExternalReferenceManagerService,
    PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN,
} from '@libs/ai-engine/domain/prompt/contracts/promptExternalReferenceManager.contract';
import { PromptSourceType } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import {
    CODE_REVIEW_CONTEXT_PATTERNS,
    extractDependenciesFromValue,
    pathToKey,
    resolveSourceTypeFromPath,
} from '@libs/ai-engine/infrastructure/adapters/services/context/code-review-context.utils';
import {
    ContextDetectionField,
    ContextReferenceDetectionService,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference-detection.service';
import { deepDifference, deepMerge } from '@libs/common/utils/deep';
import { convertTiptapJSONToText } from '@libs/common/utils/tiptap-json';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { IntegrationConfigKey, ParametersKey } from '@libs/core/domain/enums';
import { CodeReviewVersion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    CodeReviewParameter,
    DirectoryCodeReviewConfig,
    ICodeRepository,
    RepositoryCodeReviewConfig,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { RequestUserContext } from '@libs/identity/domain/user/types/request-user-context.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';
import { CreateOrUpdateCodeReviewParameterDto } from '@libs/organization/dtos/create-or-update-code-review-parameter.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { buildKodusConfigCentralizedMutationRequest } from '@libs/centralized-config/utils/kodus-config-centralized-pr.builder';
import { formatRuleToYaml } from '@libs/centralized-config/utils/kody-rules-centralized-pr.builder';
import {
    IDE_RULES_SYNC_DISABLED_EVENT,
    IdeRulesSyncDisabledEvent,
    IdeSyncDisableAction,
} from '@libs/kodyRules/domain/events/ide-rules-sync.events';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { KodyRulesType } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    InvalidGroupPathError,
    validateGroupPaths,
} from '@libs/centralized-config/utils/path-encoder';

@Injectable()
export class UpdateOrCreateCodeReviewParameterUseCase {
    private readonly logger = createLogger(
        UpdateOrCreateCodeReviewParameterUseCase.name,
    );

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly eventEmitter: EventEmitter2,
        private readonly authorizationService: AuthorizationService,
        private readonly contextReferenceDetectionService: ContextReferenceDetectionService,
        @Inject(PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN)
        private readonly promptReferenceManager: IPromptExternalReferenceManagerService,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
    ) {}

    async execute(
        body: CreateOrUpdateCodeReviewParameterDto & {
            actor?: {
                source?: 'cli' | 'web' | 'sync';
                organizationId?: string;
                userId?: string;
                userEmail?: string;
            };
            skipAuthorization?: boolean;
            requestUser?: RequestUserContext;
        },
    ): Promise<
        | ParametersEntity<ParametersKey.CODE_REVIEW_CONFIG>
        | boolean
        | CentralizedPrMetadata
    > {
        try {
            const { organizationAndTeamData, configValue, repositoryId } = body;
            let directoryPath = body.directoryPath;
            let directoryId = body.directoryId;
            let previousFolders:
                | Array<{ path: string }>
                | undefined;
            let previousRulesFileNames:
                | {
                      review?: Array<{ fileName: string; content: string }>;
                      memories?: Array<{
                          fileName: string;
                          content: string;
                      }>;
                  }
                | undefined;

            // Resolve directoryPaths: prefer array, fallback to single path
            const resolvedPaths: string[] | undefined =
                body.directoryPaths?.length > 0
                    ? body.directoryPaths
                    : directoryPath &&
                        directoryPath !== '/' &&
                        directoryPath !== ''
                      ? [directoryPath]
                      : undefined;

            if (resolvedPaths) {
                directoryPath = undefined; // handled via resolvedPaths
                try {
                    validateGroupPaths(resolvedPaths);
                } catch (error) {
                    if (error instanceof InvalidGroupPathError) {
                        throw new BadRequestException(error.message);
                    }
                    throw error;
                }
            }

            if (directoryPath === '/' || directoryPath === '') {
                directoryPath = undefined;
            }

            if (!organizationAndTeamData.organizationId) {
                organizationAndTeamData.organizationId =
                    body.actor?.organizationId ??
                    body.requestUser?.organization?.uuid;
            }

            if (!body.skipAuthorization) {
                await this.authorizationService.ensure({
                    user: body.requestUser,
                    action: Action.Create,
                    resource: ResourceType.CodeReviewSettings,
                    repoIds: [repositoryId],
                });
            }

            const codeReviewConfigs = await this.getCodeReviewConfigs(
                organizationAndTeamData,
            );
            const codeRepositories = await this.getFormattedRepositories(
                organizationAndTeamData,
            );

            const filteredRepositoryInfo =
                this.filterRepositoryInfo(codeRepositories);

            if (!codeReviewConfigs || !codeReviewConfigs.configs) {
                return await this.createNewGlobalConfig(
                    organizationAndTeamData,
                    configValue,
                    filteredRepositoryInfo,
                    body.actor,
                );
            }

            this.mergeRepositories(codeReviewConfigs, filteredRepositoryInfo);

            if (resolvedPaths) {
                if (!repositoryId) {
                    throw new Error(
                        'Repository ID is required when directory paths are provided',
                    );
                }

                const repoIndex = codeReviewConfigs.repositories.findIndex(
                    (r) => r.id === repositoryId,
                );

                if (repoIndex === -1) {
                    throw new Error('Repository configuration not found');
                }

                const targetRepo = codeReviewConfigs.repositories[repoIndex];
                if (!targetRepo.directories) {
                    targetRepo.directories = [];
                }

                if (directoryId) {
                    // Edit mode: update folders of an existing group
                    const existingGroup = targetRepo.directories.find(
                        (g) => g.id === directoryId,
                    );

                    if (!existingGroup) {
                        throw new Error(
                            'Directory group not found for editing',
                        );
                    }

                    // Ensure no path is already used in a DIFFERENT group
                    const otherUsedPaths = new Set<string>();
                    for (const group of targetRepo.directories) {
                        if (group.id !== directoryId) {
                            for (const f of group.folders || []) {
                                otherUsedPaths.add(f.path);
                            }
                        }
                    }

                    for (const path of resolvedPaths) {
                        if (otherUsedPaths.has(path)) {
                            throw new Error(
                                `Path "${path}" is already covered by another directory group`,
                            );
                        }
                    }

                    // Snapshot the pre-edit folder set so the PR builder can
                    // delete the old encoded folder when the path list changes.
                    previousFolders = (existingGroup.folders || []).map((f) => ({
                        path: f.path,
                    }));

                    // Keep existing folder IDs for paths that haven't changed
                    const existingFoldersByPath = new Map(
                        (existingGroup.folders || []).map((f) => [f.path, f]),
                    );

                    existingGroup.folders = resolvedPaths.map((p) => {
                        const existing = existingFoldersByPath.get(p);
                        return (
                            existing ?? {
                                id: uuidv4(),
                                name: p.split('/').pop() || '',
                                path: p,
                            }
                        );
                    });

                    existingGroup.name = existingGroup.folders[0]?.name ?? '';

                    const pathsChanged =
                        previousFolders.length !==
                            existingGroup.folders.length ||
                        previousFolders.some(
                            (prev) =>
                                !existingGroup.folders.some(
                                    (curr) => curr.path === prev.path,
                                ),
                        );

                    if (pathsChanged) {
                        previousRulesFileNames =
                            await this.collectGroupRuleFileNames(
                                organizationAndTeamData.organizationId!,
                                repositoryId,
                                existingGroup.id,
                            );
                    } else {
                        previousFolders = undefined;
                    }
                } else {
                    // Create mode: check for existing group with exact same paths
                    const existingGroup = targetRepo.directories.find(
                        (group) =>
                            group.folders &&
                            group.folders.length === resolvedPaths.length &&
                            resolvedPaths.every((p) =>
                                group.folders.some((f) => f.path === p),
                            ),
                    );

                    if (existingGroup) {
                        directoryId = existingGroup.id;
                    } else {
                        // Find groups that partially overlap with the
                        // requested path set (any shared path).
                        const overlappingGroups =
                            targetRepo.directories.filter((group) =>
                                (group.folders || []).some((f) =>
                                    resolvedPaths.includes(f.path),
                                ),
                            );

                        const isSyncActor =
                            body.actor?.source === 'sync';

                        if (overlappingGroups.length > 0) {
                            // Repo-first sync: when the centralized repo
                            // declares a different path set for a group, treat
                            // it as authoritative and absorb a single partially
                            // overlapping group (keep its id + rules linked).
                            // Anything beyond one overlap is ambiguous (merging
                            // configs/rules across many groups isn't safe), so
                            // fall back to the original conflict error.
                            if (
                                isSyncActor &&
                                overlappingGroups.length === 1
                            ) {
                                const absorbed = overlappingGroups[0];
                                const existingFoldersByPath = new Map(
                                    (absorbed.folders || []).map((f) => [
                                        f.path,
                                        f,
                                    ]),
                                );
                                absorbed.folders = resolvedPaths.map((p) => {
                                    const existing =
                                        existingFoldersByPath.get(p);
                                    return (
                                        existing ?? {
                                            id: uuidv4(),
                                            name: p.split('/').pop() || '',
                                            path: p,
                                        }
                                    );
                                });
                                absorbed.name =
                                    absorbed.folders[0]?.name ?? '';
                                directoryId = absorbed.id;
                            } else {
                                throw new Error(
                                    `Path "${overlappingGroups[0].folders.find((f) => resolvedPaths.includes(f.path))?.path}" is already covered by another directory group`,
                                );
                            }
                        } else {
                            const firstName =
                                resolvedPaths[0].split('/').pop() || '';

                            const newGroup: DirectoryCodeReviewConfig = {
                                id: uuidv4(),
                                name: firstName,
                                isSelected: true,
                                configs: {},
                                folders: resolvedPaths.map((p) => ({
                                    id: uuidv4(),
                                    name: p.split('/').pop() || '',
                                    path: p,
                                })),
                            };

                            targetRepo.directories.push(newGroup);
                            directoryId = newGroup.id;
                        }
                    }
                }
            } else if (directoryPath) {
                // Legacy single-path support (CLI, sync)
                if (directoryId) {
                    throw new Error(
                        'Directory ID should not be provided when directory path is provided',
                    );
                }

                if (!repositoryId) {
                    throw new Error(
                        'Repository ID is required when directory path is provided',
                    );
                }

                const repoIndex = codeReviewConfigs.repositories.findIndex(
                    (r) => r.id === repositoryId,
                );

                if (repoIndex === -1) {
                    throw new Error('Repository configuration not found');
                }

                const targetRepo = codeReviewConfigs.repositories[repoIndex];
                if (!targetRepo.directories) {
                    targetRepo.directories = [];
                }

                // Find existing group that contains this path
                const existingGroup = targetRepo.directories.find((group) =>
                    group.folders?.some((f) => f.path === directoryPath),
                );

                if (existingGroup) {
                    directoryId = existingGroup.id;
                } else {
                    const segments = directoryPath.split('/');
                    const name = segments[segments.length - 1];

                    const newGroup: DirectoryCodeReviewConfig = {
                        id: uuidv4(),
                        name,
                        isSelected: true,
                        configs: {},
                        folders: [
                            {
                                id: uuidv4(),
                                name,
                                path: directoryPath,
                            },
                        ],
                    };

                    targetRepo.directories.push(newGroup);
                    directoryId = newGroup.id;
                }
            }

            const previousIdeSyncEnabled =
                !!repositoryId &&
                codeReviewConfigs?.repositories?.find(
                    (r) => r.id === repositoryId,
                )?.configs?.ideRulesSyncEnabled === true;

            const result = await this.handleConfigUpdate(
                organizationAndTeamData,
                codeReviewConfigs,
                configValue,
                body.actor,
                repositoryId,
                directoryId,
                body.requestUser,
                previousFolders,
                previousRulesFileNames,
            );

            if (
                previousIdeSyncEnabled &&
                (configValue as any)?.ideRulesSyncEnabled === false
            ) {
                // The action picked in the toggle-off modal in the web UI.
                // Defaulting to 'keep' here is deliberate: any caller that
                // doesn't pass an explicit action gets the least destructive
                // option, which avoids the silent-deletion regression.
                const action: IdeSyncDisableAction =
                    (configValue as any)?.ideSyncDisableAction ?? 'keep';

                const event: IdeRulesSyncDisabledEvent = {
                    organizationAndTeamData,
                    repositoryId: repositoryId!,
                    action,
                };
                this.eventEmitter.emit(IDE_RULES_SYNC_DISABLED_EVENT, event);
            }

            return result;
        } catch (error) {
            if (error instanceof ForbiddenException) {
                throw error;
            }

            this.handleError(error, body);
            throw new Error('Error creating or updating parameters', {
                cause: error,
            });
        }
    }

    private async getCodeReviewConfigs(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CodeReviewParameter> {
        const codeReviewConfig = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );

        return codeReviewConfig?.configValue;
    }

    private async getFormattedRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        return await this.integrationConfigService.findIntegrationConfigFormatted<
            ICodeRepository[]
        >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);
    }

    private filterRepositoryInfo(codeRepositories: ICodeRepository[]) {
        return codeRepositories.map((repository) => ({
            id: repository.id,
            name: repository.name,
            isSelected: false,
            directories: repository.directories ?? [],
            configs: {},
        }));
    }

    private async createNewGlobalConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        configValue: CreateOrUpdateCodeReviewParameterDto['configValue'],
        filteredRepositoryInfo: RepositoryCodeReviewConfig[],
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        const defaultConfig = getDefaultKodusConfigFile();

        const sanitizedConfigValue =
            this.stripCustomMessagesFromConfig(configValue);

        const updatedConfigValue = this.stripCustomMessagesFromConfig(
            deepDifference(defaultConfig, sanitizedConfigValue),
        );

        const centralizedPr = await this.createCentralizedMutationIfEnabled({
            organizationAndTeamData,
            actor,
            level: ConfigLevel.GLOBAL,
            oldDelta: {},
            newDelta: updatedConfigValue,
        });

        await this.processExternalReferencesInline(
            updatedConfigValue,
            organizationAndTeamData,
            'global',
            undefined,
            'global',
        );

        const updatedConfig = {
            id: 'global',
            name: 'Global',
            isSelected: true,
            configs: updatedConfigValue,
            repositories: filteredRepositoryInfo,
        } as CodeReviewParameter;

        const persisted =
            await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                updatedConfig,
                organizationAndTeamData,
            );

        // Surface the PR metadata when one was opened so the UI can link to it.
        return centralizedPr ?? persisted;
    }

    private mergeRepositories(
        codeReviewConfigs: CodeReviewParameter,
        filteredRepositoryInfo: RepositoryCodeReviewConfig[],
    ) {
        const existingRepoIds = new Set(
            (codeReviewConfigs.repositories || []).map((repo) => repo.id),
        );

        const updatedRepositories = [
            ...(codeReviewConfigs.repositories || []),
            ...filteredRepositoryInfo.filter(
                (repo) => !existingRepoIds.has(repo.id),
            ),
        ];

        codeReviewConfigs.repositories = updatedRepositories;
    }

    private async handleConfigUpdate(
        organizationAndTeamData: OrganizationAndTeamData,
        codeReviewConfigs: CodeReviewParameter,
        newConfigValue: CreateOrUpdateCodeReviewParameterDto['configValue'],
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
        repositoryId?: string,
        directoryId?: string,
        requestUser?: RequestUserContext,
        previousFolders?: Array<{ path: string }>,
        previousRulesFileNames?: {
            review?: Array<{ fileName: string; content: string }>;
            memories?: Array<{ fileName: string; content: string }>;
        },
    ) {
        const resolver = new ConfigResolver(codeReviewConfigs);

        const parentConfig = this.stripCustomMessagesFromConfig(
            await resolver.getResolvedParentConfig(repositoryId, directoryId),
        );

        const sanitizedIncomingConfig =
            this.stripCustomMessagesFromConfig(newConfigValue);

        let oldConfig: CreateOrUpdateCodeReviewParameterDto['configValue'];
        let level: ConfigLevel;
        let repository: RepositoryCodeReviewConfig | undefined;
        let directory: DirectoryCodeReviewConfig | undefined;
        let isCreation = false;

        if (directoryId && repositoryId) {
            level = ConfigLevel.DIRECTORY;
            repository = resolver.findRepository(repositoryId);
            directory = resolver.findDirectory(repository, directoryId);
            oldConfig = this.stripCustomMessagesFromConfig(
                directory.configs ?? {},
            );
            isCreation = !directory.isSelected;
        } else if (repositoryId) {
            level = ConfigLevel.REPOSITORY;
            repository = resolver.findRepository(repositoryId);
            oldConfig = this.stripCustomMessagesFromConfig(
                repository.configs ?? {},
            );
            isCreation = !repository.isSelected;
        } else {
            level = ConfigLevel.GLOBAL;
            oldConfig = this.stripCustomMessagesFromConfig(
                codeReviewConfigs.configs ?? {},
            );
        }

        // During sync the centralized config file is the source of truth, so
        // we ignore the previous database state and rebuild the resolved config
        // from the file content plus the parent defaults. This ensures that
        // properties removed from the file are also removed from the database.
        const newResolvedConfig = this.stripCustomMessagesFromConfig(
            actor?.source === 'sync'
                ? deepMerge(parentConfig, sanitizedIncomingConfig)
                : deepMerge(parentConfig, oldConfig, sanitizedIncomingConfig),
        );

        const newDelta = this.stripCustomMessagesFromConfig(
            deepDifference(parentConfig, newResolvedConfig),
        );

        const pathsChanged =
            !!previousFolders && previousFolders.length > 0;
        const isSelectionOnlyPayload =
            this.isSelectionOnlyConfigPayload(sanitizedIncomingConfig) &&
            level !== ConfigLevel.GLOBAL &&
            !pathsChanged;

        const centralizedPr = isSelectionOnlyPayload
            ? null
            : await this.createCentralizedMutationIfEnabled({
                  organizationAndTeamData,
                  actor,
                  level,
                  repository,
                  directory,
                  oldDelta: oldConfig,
                  newDelta,
                  previousFolders,
                  previousRulesFileNames,
              });

        // Every UI-triggered change (structural or config) lands in the DB
        // immediately and the centralized PR is best-effort. If the user
        // closes the PR without merging, the next sync brings the repo
        // state back over the DB (repo wins via sync). This keeps the UI
        // responsive while preserving "centralized repo as source of truth"
        // on the next reconciliation.
        // (`centralizedPr` is still surfaced at the end so the UI can link
        // to the PR.)

        await this.processExternalReferencesInline(
            newDelta,
            organizationAndTeamData,
            repositoryId,
            directoryId,
            repository?.name ?? repositoryId ?? 'global',
        );

        const updater = resolver.createUpdater(
            newDelta,
            repositoryId,
            directoryId,
        );

        const updatedCodeReviewConfigValue = produce(
            codeReviewConfigs,
            updater,
        );

        await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CODE_REVIEW_CONFIG,
            updatedCodeReviewConfigValue,
            organizationAndTeamData,
        );

        await this.logConfigUpdate({
            actor,
            organizationAndTeamData,
            oldConfig,
            newConfig: newDelta,
            level,
            repository,
            directory,
            isCreation,
            requestUser,
        });

        return centralizedPr ?? true;
    }

    private async createCentralizedMutationIfEnabled(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        };
        level: ConfigLevel;
        oldDelta?: CreateOrUpdateCodeReviewParameterDto['configValue'];
        newDelta: CreateOrUpdateCodeReviewParameterDto['configValue'];
        repository?: RepositoryCodeReviewConfig;
        directory?: DirectoryCodeReviewConfig;
        previousFolders?: Array<{ path: string }>;
        previousRulesFileNames?: {
            review?: Array<{ fileName: string; content: string }>;
            memories?: Array<{ fileName: string; content: string }>;
        };
    }): Promise<CentralizedPrMetadata | null> {
        if (params.actor?.source === 'sync') {
            return null;
        }

        // Check if centralized config is actually enabled before proceeding.
        const centralizedRepository =
            await this.centralizedConfigPrService?.getCentralizedRepositoryIfEnabled(
                params.organizationAndTeamData,
            );

        if (!centralizedRepository) {
            return null;
        }

        const existingScopedConfigFileContent =
            await this.centralizedConfigPrService?.getScopedKodusConfigFileContent(
                {
                    organizationAndTeamData: params.organizationAndTeamData,
                    repositoryId:
                        params.level === ConfigLevel.GLOBAL
                            ? undefined
                            : params.repository?.id,
                    directoryPath:
                        params.level === ConfigLevel.DIRECTORY
                            ? params.directory?.folders?.[0]?.path
                            : undefined,
                },
            );

        const existingScopedConfigWithoutCustomMessages =
            this.stripCustomMessagesFromConfig(
                (existingScopedConfigFileContent ||
                    {}) as CreateOrUpdateCodeReviewParameterDto['configValue'],
            );

        const oldDeltaWithoutCustomMessages =
            this.stripCustomMessagesFromConfig(params.oldDelta || {});

        const configBaseWithRemovals = this.applyDeltaKeyRemovals({
            existingScopedConfig:
                (existingScopedConfigWithoutCustomMessages as Record<
                    string,
                    any
                >) || {},
            oldDelta:
                (oldDeltaWithoutCustomMessages as Record<string, any>) || {},
            nextDelta: (params.newDelta as Record<string, any>) || {},
        });

        const mergedConfigFileContent = this.stripCustomMessagesFromConfig(
            deepMerge(configBaseWithRemovals || {}, params.newDelta || {}),
        );

        const configFileContent: Record<string, any> = {
            ...((mergedConfigFileContent as Record<string, any>) || {}),
        };

        const existingCustomMessages =
            existingScopedConfigFileContent?.customMessages;

        if (
            existingCustomMessages &&
            typeof existingCustomMessages === 'object' &&
            !Array.isArray(existingCustomMessages) &&
            Object.keys(existingCustomMessages).length > 0
        ) {
            configFileContent.customMessages = existingCustomMessages;
        }

        const folderRenamePending =
            params.previousFolders && params.previousFolders.length > 0;

        if (
            !folderRenamePending &&
            this.hasNoScopedConfigChanges(
                existingScopedConfigFileContent,
                configFileContent,
            )
        ) {
            return {
                mode: 'centralized-pr',
                pending: true,
                message:
                    'No centralized changes detected for this scope. The file already contains this configuration.',
            };
        }

        const repositoryLabel = params.repository?.name || 'global';
        const directoryLabel =
            params.directory?.folders?.[0]?.path || 'root';

        const isDirectoryGroup =
            params.level === ConfigLevel.DIRECTORY &&
            !!params.directory?.folders &&
            params.directory.folders.length > 0;

        const pr =
            await this.centralizedConfigPrService?.createMutationPullRequestIfEnabled(
                buildKodusConfigCentralizedMutationRequest({
                    centralizedConfigPrService: this.centralizedConfigPrService,
                    organizationAndTeamData: params.organizationAndTeamData,
                    repositoryId:
                        params.level === ConfigLevel.GLOBAL
                            ? undefined
                            : params.repository?.id,
                    directoryPath: isDirectoryGroup
                        ? undefined
                        : params.level === ConfigLevel.DIRECTORY
                          ? params.directory?.folders?.[0]?.path
                          : undefined,
                    folders: isDirectoryGroup
                        ? params.directory?.folders
                        : undefined,
                    previousFolders: isDirectoryGroup
                        ? params.previousFolders
                        : undefined,
                    previousRulesFileNames: isDirectoryGroup
                        ? params.previousRulesFileNames
                        : undefined,
                    configFileContent:
                        Object.keys(configFileContent).length > 0
                            ? configFileContent
                            : null,
                    title: `Update Kodus config for ${repositoryLabel}${params.level === ConfigLevel.DIRECTORY ? ` (${directoryLabel})` : ''}`,
                    description:
                        'This pull request proposes a code review configuration change in centralized config mode.',
                    commitMessage: `update code review config for ${repositoryLabel}`,
                    sourceBranchPrefix: `kodus-centralized-config-${params.level}`,
                    centralizedModeMessage:
                        'Centralized config is enabled. Code review settings change proposed through a pull request.',
                }),
            );

        if (!pr || pr.mode !== 'centralized-pr') {
            return null;
        }

        return pr;
    }

    private async collectGroupRuleFileNames(
        organizationId: string,
        repositoryId: string,
        directoryId: string,
    ): Promise<{
        review: Array<{ fileName: string; content: string }>;
        memories: Array<{ fileName: string; content: string }>;
    }> {
        const review: Array<{ fileName: string; content: string }> = [];
        const memories: Array<{ fileName: string; content: string }> = [];

        if (!organizationId || !repositoryId || !directoryId) {
            return { review, memories };
        }

        try {
            const entities = await this.kodyRulesService.find({
                organizationId,
                rules: [
                    {
                        repositoryId,
                        directoryId,
                    },
                ],
            } as any);

            if (!Array.isArray(entities)) {
                return { review, memories };
            }

            for (const entity of entities) {
                for (const rule of (entity as any)?.rules ?? []) {
                    if (
                        !rule ||
                        rule.repositoryId !== repositoryId ||
                        rule.directoryId !== directoryId ||
                        !rule.title
                    ) {
                        continue;
                    }

                    const fileName = `${this.centralizedConfigPrService.sanitizeFileName(
                        rule.title,
                        'rule',
                    )}.yml`;

                    const content = formatRuleToYaml(rule);
                    const entry = { fileName, content };

                    if (rule.type === KodyRulesType.MEMORY) {
                        memories.push(entry);
                    } else {
                        review.push(entry);
                    }
                }
            }
        } catch {
            // Fall through with whatever was collected; missing deletes are
            // not fatal — the next sync will reconcile stale files.
        }

        return { review, memories };
    }

    private async processExternalReferencesInline(
        configValue: CreateOrUpdateCodeReviewParameterDto['configValue'],
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId?: string,
        directoryId?: string,
        repositoryName?: string,
    ): Promise<void> {
        const { summaryText, overrides, contextTarget, nestedTarget } =
            this.resolveOverridesForContext(configValue);

        const baseConsumerId = this.resolveBaseConsumerId(configValue);

        const normalizedFields: Array<{
            path: string[];
            text: string;
            sourceType: PromptSourceType;
        }> = [];

        const resolvePromptText = (value: unknown): string => {
            if (value === undefined || value === null) {
                return '';
            }

            if (typeof value === 'string') {
                return convertTiptapJSONToText(value).trim();
            }

            if (typeof value === 'object') {
                if ('value' in value) {
                    return resolvePromptText(
                        (value as { value?: unknown }).value,
                    );
                }

                return convertTiptapJSONToText(
                    value as Record<string, unknown>,
                ).trim();
            }

            return '';
        };

        // Extrair todos os campos de texto dos prompts
        if (summaryText !== undefined) {
            const text = resolvePromptText(summaryText);
            if (text) {
                normalizedFields.push({
                    path: ['summary', 'customInstructions'],
                    text,
                    sourceType: PromptSourceType.CUSTOM_INSTRUCTION,
                });
            }
        }

        const v2 = overrides ?? {};

        if (v2.categories?.descriptions) {
            for (const [key, value] of Object.entries(
                v2.categories.descriptions,
            )) {
                const text = resolvePromptText(value);
                if (!text) continue;

                const sourceType = resolveSourceTypeFromPath([
                    'v2PromptOverrides',
                    'categories',
                    'descriptions',
                    key,
                ]);
                if (!sourceType) continue;

                normalizedFields.push({
                    path: [
                        'v2PromptOverrides',
                        'categories',
                        'descriptions',
                        key,
                    ],
                    text,
                    sourceType,
                });
            }
        }

        if (v2.severity?.flags) {
            for (const [key, value] of Object.entries(v2.severity.flags)) {
                const text = resolvePromptText(value);
                if (!text) continue;

                const sourceType = resolveSourceTypeFromPath([
                    'v2PromptOverrides',
                    'severity',
                    'flags',
                    key,
                ]);
                if (!sourceType) continue;

                normalizedFields.push({
                    path: ['v2PromptOverrides', 'severity', 'flags', key],
                    text,
                    sourceType,
                });
            }
        }

        const generationOverride = v2.generation?.main;

        if (generationOverride !== undefined) {
            const text = resolvePromptText(generationOverride);
            if (text) {
                const sourceType = resolveSourceTypeFromPath([
                    'v2PromptOverrides',
                    'generation',
                    'main',
                ]);

                if (sourceType) {
                    normalizedFields.push({
                        path: ['v2PromptOverrides', 'generation', 'main'],
                        text,
                        sourceType,
                    });
                }
            }
        }

        if (!normalizedFields.length) {
            return;
        }

        const detectionFields: ContextDetectionField[] = normalizedFields.map(
            (field) => {
                const pathKey = pathToKey(field.path);
                const { markers } = extractDependenciesFromValue(
                    field.text,
                    CODE_REVIEW_CONTEXT_PATTERNS,
                );

                return {
                    fieldId: pathKey,
                    path: field.path,
                    sourceType: field.sourceType,
                    text: field.text,
                    inlineMarkers: markers,
                    metadata: {
                        sourceSnippet: field.text,
                    },
                    consumerKind: 'prompt_section',
                    consumerName: pathKey,
                    conversationIdOverride: `${baseConsumerId}#${pathKey}`,
                    requestDomain: 'general',
                    taskIntent: 'Process codeReviewConfig references',
                } satisfies ContextDetectionField;
            },
        );

        this.logger.log({
            message: `🔧 Processing ${detectionFields.length} prompt sections for context references`,
            context: UpdateOrCreateCodeReviewParameterUseCase.name,
            metadata: {
                baseConsumerId,
                organizationId: organizationAndTeamData.organizationId,
            },
        });

        const contextEntityId = this.buildContextReferenceEntityId(
            organizationAndTeamData,
            repositoryId ?? 'global',
            directoryId,
        );

        const contextReferenceId =
            await this.contextReferenceDetectionService.detectAndSaveReferences(
                {
                    entityType: 'codeReviewConfig',
                    entityId: contextEntityId,
                    fields: detectionFields,
                    repositoryId: repositoryId ?? 'global',
                    repositoryName: repositoryName ?? repositoryId ?? 'global',
                    organizationAndTeamData,
                },
            );

        this.logger.log({
            message: `✅ Context references persisted for codeReviewConfig`,
            context: UpdateOrCreateCodeReviewParameterUseCase.name,
            metadata: {
                baseConsumerId,
                contextReferenceId,
                organizationId: organizationAndTeamData.organizationId,
            },
        });

        if (contextReferenceId) {
            contextTarget.contextReferenceId = contextReferenceId;
            if (nestedTarget) {
                nestedTarget.contextReferenceId = contextReferenceId;
            }
        }
    }

    private resolveOverridesForContext(
        config: CreateOrUpdateCodeReviewParameterDto['configValue'],
    ): {
        summaryText?: string;
        overrides: PromptOverrides | undefined;
        contextTarget: Record<string, any>;
        nestedTarget?: Record<string, any>;
    } {
        const contextTarget = config as Record<string, any>;
        let nestedTarget: Record<string, any> | undefined;
        let overrides: PromptOverrides | undefined;

        const maybeNested =
            config &&
            typeof config === 'object' &&
            'configs' in config &&
            (config as Record<string, unknown>).configs &&
            typeof (config as Record<string, unknown>).configs === 'object'
                ? ((config as Record<string, unknown>).configs as Record<
                      string,
                      unknown
                  >)
                : undefined;

        if (config?.v2PromptOverrides) {
            overrides = config.v2PromptOverrides as PromptOverrides;
        } else if (
            maybeNested &&
            typeof maybeNested.v2PromptOverrides === 'object' &&
            maybeNested.v2PromptOverrides
        ) {
            overrides = maybeNested.v2PromptOverrides as PromptOverrides;
            nestedTarget = maybeNested as Record<string, any>;
        }

        const summaryFromContext =
            contextTarget?.summary &&
            typeof contextTarget.summary === 'object' &&
            contextTarget.summary !== null &&
            typeof contextTarget.summary.customInstructions === 'string'
                ? (contextTarget.summary.customInstructions as string)
                : undefined;

        const summaryFromNested =
            nestedTarget?.summary &&
            typeof nestedTarget.summary === 'object' &&
            nestedTarget.summary !== null &&
            typeof nestedTarget.summary.customInstructions === 'string'
                ? (nestedTarget.summary.customInstructions as string)
                : undefined;

        return {
            summaryText: summaryFromContext ?? summaryFromNested ?? undefined,
            overrides,
            contextTarget,
            nestedTarget,
        };
    }

    private resolveBaseConsumerId(
        config: CreateOrUpdateCodeReviewParameterDto['configValue'],
    ): string {
        if (config?.codeReviewVersion === CodeReviewVersion.v2) {
            return 'code-review-v2';
        }

        if (config?.codeReviewVersion === CodeReviewVersion.LEGACY) {
            return 'code-review-legacy';
        }

        return 'code-review';
    }

    private async logConfigUpdate(options: {
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        };
        organizationAndTeamData: OrganizationAndTeamData;
        oldConfig: CreateOrUpdateCodeReviewParameterDto['configValue'];
        newConfig: CreateOrUpdateCodeReviewParameterDto['configValue'];
        level: ConfigLevel;
        repository?: RepositoryCodeReviewConfig;
        directory?: DirectoryCodeReviewConfig;
        isCreation?: boolean;
        requestUser?: RequestUserContext;
    }) {
        const {
            organizationAndTeamData,
            oldConfig,
            newConfig,
            level,
            repository,
            directory,
            isCreation,
        } = options;

        try {
            const actor = options.actor ?? {
                source: 'web',
                organizationId: options.requestUser?.organization?.uuid,
                userId: options.requestUser?.uuid,
                userEmail: options.requestUser?.email,
            };

            if (!actor.organizationId || !actor.userId || !actor.userEmail) {
                return;
            }

            this.eventEmitter.emit(AuditLogEvents.CODE_REVIEW_CONFIG, {
                organizationAndTeamData: {
                    ...organizationAndTeamData,
                    organizationId: actor.organizationId,
                },
                userInfo: {
                    userId: actor.userId,
                    userEmail: actor.userEmail,
                },
                oldConfig,
                newConfig,
                actionType: ActionType.EDIT,
                configLevel: level,
                repository,
                directory,
                isCreation,
            });
        } catch (error) {
            this.logger.error({
                message: `Error saving code review settings log for ${level.toLowerCase()} level`,
                error: this.normalizeError(error),
                context: UpdateOrCreateCodeReviewParameterUseCase.name,
                metadata: {
                    organizationAndTeamData: organizationAndTeamData,
                },
            });
        }
    }

    private handleError(
        error: any,
        body: CreateOrUpdateCodeReviewParameterDto,
    ) {
        this.logger.error({
            message:
                'Error creating or updating code review configuration parameter',
            context: UpdateOrCreateCodeReviewParameterUseCase.name,
            error: error,
            metadata: {
                parametersKey: ParametersKey.CODE_REVIEW_CONFIG,
                configValue: body.configValue,
                organizationAndTeamData: body.organizationAndTeamData,
            },
        });
    }

    private normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    private buildContextReferenceEntityId(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
        directoryId?: string,
    ): string {
        return this.promptReferenceManager.buildConfigKey(
            organizationAndTeamData,
            repositoryId,
            directoryId,
        );
    }

    private stripCustomMessagesFromConfig(
        config: CreateOrUpdateCodeReviewParameterDto['configValue'],
    ): CreateOrUpdateCodeReviewParameterDto['configValue'] {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            return config;
        }

        const { customMessages: _ignored, ...rest } = config as Record<
            string,
            unknown
        >;

        return rest as CreateOrUpdateCodeReviewParameterDto['configValue'];
    }

    private isSelectionOnlyConfigPayload(
        config: CreateOrUpdateCodeReviewParameterDto['configValue'],
    ): boolean {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            return false;
        }

        return this.hasOnlyUndefinedValues(config as Record<string, unknown>);
    }

    private hasOnlyUndefinedValues(obj: Record<string, unknown>): boolean {
        const entries = Object.entries(obj);

        if (entries.length === 0) {
            return true;
        }

        for (const [, value] of entries) {
            if (value === undefined) {
                continue;
            }

            if (
                value &&
                typeof value === 'object' &&
                !Array.isArray(value) &&
                this.hasOnlyUndefinedValues(value as Record<string, unknown>)
            ) {
                continue;
            }

            return false;
        }

        return true;
    }

    private applyDeltaKeyRemovals(params: {
        existingScopedConfig: Record<string, any>;
        oldDelta: Record<string, any>;
        nextDelta: Record<string, any>;
    }): Record<string, any> {
        const clonedExisting = JSON.parse(
            JSON.stringify(params.existingScopedConfig || {}),
        );

        this.pruneRemovedDeltaKeysRecursively(
            clonedExisting,
            params.oldDelta || {},
            params.nextDelta || {},
        );

        return clonedExisting;
    }

    private pruneRemovedDeltaKeysRecursively(
        target: Record<string, any>,
        oldDeltaNode: Record<string, any>,
        nextDeltaNode: Record<string, any>,
    ): void {
        if (!this.isPlainObject(target) || !this.isPlainObject(oldDeltaNode)) {
            return;
        }

        for (const key of Object.keys(oldDeltaNode)) {
            const hasNextKey =
                this.isPlainObject(nextDeltaNode) &&
                Object.prototype.hasOwnProperty.call(nextDeltaNode, key);

            if (!hasNextKey) {
                delete target[key];
                continue;
            }

            const oldChild = oldDeltaNode[key];
            const nextChild = nextDeltaNode[key];
            const targetChild = target[key];

            if (
                this.isPlainObject(oldChild) &&
                this.isPlainObject(nextChild) &&
                this.isPlainObject(targetChild)
            ) {
                this.pruneRemovedDeltaKeysRecursively(
                    targetChild,
                    oldChild,
                    nextChild,
                );

                if (
                    this.isPlainObject(targetChild) &&
                    Object.keys(targetChild).length === 0 &&
                    this.isPlainObject(nextChild) &&
                    Object.keys(nextChild).length === 0
                ) {
                    delete target[key];
                }
            }
        }
    }

    private isPlainObject(value: unknown): value is Record<string, any> {
        return (
            typeof value === 'object' && value !== null && !Array.isArray(value)
        );
    }

    private hasNoScopedConfigChanges(
        existingScopedConfig: Record<string, any> | null | undefined,
        nextScopedConfig: Record<string, any>,
    ): boolean {
        return this.isDeepEqualIgnoringEmpty(
            existingScopedConfig || {},
            nextScopedConfig || {},
        );
    }

    private isDeepEqualIgnoringEmpty(a: unknown, b: unknown): boolean {
        if (this.isDeepEmpty(a) && this.isDeepEmpty(b)) {
            return true;
        }

        if (this.isPlainObject(a) && this.isPlainObject(b)) {
            const objA = a as Record<string, unknown>;
            const objB = b as Record<string, unknown>;
            const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);
            for (const key of keys) {
                if (!this.isDeepEqualIgnoringEmpty(objA[key], objB[key])) {
                    return false;
                }
            }
            return true;
        }

        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (!this.isDeepEqualIgnoringEmpty(a[i], b[i])) return false;
            }
            return true;
        }

        return a === b;
    }

    private isDeepEmpty(value: unknown): boolean {
        if (value === undefined || value === null) {
            return true;
        }

        if (Array.isArray(value)) {
            return value.length === 0;
        }

        if (typeof value !== 'object') {
            return false;
        }

        return Object.values(value).every((child) => this.isDeepEmpty(child));
    }
}

class ConfigResolver {
    private readonly defaultConfig = getDefaultKodusConfigFile();

    constructor(private readonly codeReviewConfigs: CodeReviewParameter) {}

    public findRepository(repositoryId: string): RepositoryCodeReviewConfig {
        const repo = this.codeReviewConfigs.repositories.find(
            (r) => r.id === repositoryId,
        );
        if (!repo) {
            throw new Error('Repository configuration not found');
        }
        return repo;
    }

    public findDirectory(
        repository: RepositoryCodeReviewConfig,
        directoryId: string,
    ): DirectoryCodeReviewConfig {
        const dir = repository.directories?.find((d) => d.id === directoryId);
        if (!dir) {
            throw new Error('Directory configuration not found');
        }
        return dir;
    }

    public async getResolvedParentConfig(
        repositoryId?: string,
        directoryId?: string,
    ): Promise<CreateOrUpdateCodeReviewParameterDto['configValue']> {
        if (directoryId && repositoryId) {
            return this.getResolvedRepositoryConfig(repositoryId);
        }
        if (repositoryId) {
            return this.getResolvedGlobalConfig();
        }

        return this
            .defaultConfig as CreateOrUpdateCodeReviewParameterDto['configValue'];
    }

    public createUpdater(
        newDelta: CreateOrUpdateCodeReviewParameterDto['configValue'],
        repositoryId?: string,
        directoryId?: string,
    ): (draft: CodeReviewParameter) => void {
        return (draft) => {
            if (directoryId && repositoryId) {
                const repoIndex = draft.repositories.findIndex(
                    (r) => r.id === repositoryId,
                );

                const dirIndex = draft.repositories[
                    repoIndex
                ].directories.findIndex((d) => d.id === directoryId);

                draft.repositories[repoIndex].isSelected = true;

                draft.repositories[repoIndex].directories[dirIndex].configs =
                    newDelta;

                draft.repositories[repoIndex].directories[dirIndex].isSelected =
                    true;
            } else if (repositoryId) {
                const repoIndex = draft.repositories.findIndex(
                    (r) => r.id === repositoryId,
                );

                draft.repositories[repoIndex].configs = newDelta;

                draft.repositories[repoIndex].isSelected = true;
            } else {
                draft.configs = newDelta;
            }
        };
    }

    private getResolvedGlobalConfig(): CreateOrUpdateCodeReviewParameterDto['configValue'] {
        return deepMerge(
            this
                .defaultConfig as CreateOrUpdateCodeReviewParameterDto['configValue'],
            this.codeReviewConfigs.configs ?? {},
        );
    }

    private async getResolvedRepositoryConfig(
        repositoryId: string,
    ): Promise<CreateOrUpdateCodeReviewParameterDto['configValue']> {
        const repository = this.findRepository(repositoryId);
        const resolvedGlobal = this.getResolvedGlobalConfig();

        return deepMerge(resolvedGlobal, repository.configs ?? {});
    }
}

type PromptOverrides = NonNullable<
    CreateOrUpdateCodeReviewParameterDto['configValue']['v2PromptOverrides']
>;
