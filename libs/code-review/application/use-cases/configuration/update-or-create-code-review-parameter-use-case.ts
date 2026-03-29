import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { produce } from 'immer';
import { v4 as uuidv4 } from 'uuid';

import { createLogger } from '@kodus/flow';
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
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
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

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly authorizationService: AuthorizationService,

        private readonly contextReferenceDetectionService: ContextReferenceDetectionService,

        @Inject(PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN)
        private readonly promptReferenceManager: IPromptExternalReferenceManagerService,
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
        },
    ): Promise<ParametersEntity<ParametersKey.CODE_REVIEW_CONFIG> | boolean> {
        try {
            const { organizationAndTeamData, configValue, repositoryId } = body;
            let directoryPath = body.directoryPath;
            let directoryId = body.directoryId;

            if (directoryPath === '/' || directoryPath === '') {
                directoryPath = undefined;
            }

            if (!organizationAndTeamData.organizationId) {
                organizationAndTeamData.organizationId =
                    body.actor?.organizationId ??
                    this.request?.user?.organization?.uuid;
            }

            await this.ensureManualChangesAllowed(
                organizationAndTeamData,
                body.actor?.source,
            );

            if (!body.skipAuthorization) {
                await this.authorizationService.ensure({
                    user: this.request?.user,
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
                );
            }

            this.mergeRepositories(codeReviewConfigs, filteredRepositoryInfo);

            if (directoryPath) {
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

                const existingDirectory = targetRepo.directories.find(
                    (d) => d.path === directoryPath,
                );

                if (existingDirectory) {
                    directoryId = existingDirectory.id;
                } else {
                    const segments = directoryPath.split('/');
                    const name = segments[segments.length - 1];

                    const newDirectory: DirectoryCodeReviewConfig = {
                        id: uuidv4(),
                        name,
                        path: directoryPath,
                        isSelected: true,
                        configs: {},
                    };

                    targetRepo.directories.push(newDirectory);
                    directoryId = newDirectory.id;
                }
            }

            const result = await this.handleConfigUpdate(
                organizationAndTeamData,
                codeReviewConfigs,
                configValue,
                body.actor,
                repositoryId,
                directoryId,
            );

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

    private async ensureManualChangesAllowed(
        organizationAndTeamData: OrganizationAndTeamData,
        source?: 'cli' | 'web' | 'sync',
    ): Promise<void> {
        if (source === 'sync') {
            return;
        }

        const centralizedConfig = await this.parametersService.findByKey(
            ParametersKey.CENTRALIZED_CONFIG,
            organizationAndTeamData,
        );

        if (centralizedConfig?.configValue?.enabled === true) {
            throw new ForbiddenException(
                'Code review settings are locked while centralized configuration is enabled.',
            );
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
    ) {
        // Process references inline (mantém lógica original complexa)
        await this.processExternalReferencesInline(
            configValue,
            organizationAndTeamData,
            'global',
            undefined,
            'global',
        );

        const defaultConfig = getDefaultKodusConfigFile();

        const updatedConfigValue = deepDifference(defaultConfig, configValue);

        const updatedConfig = {
            id: 'global',
            name: 'Global',
            isSelected: true,
            configs: updatedConfigValue,
            repositories: filteredRepositoryInfo,
        } as CodeReviewParameter;

        return await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CODE_REVIEW_CONFIG,
            updatedConfig,
            organizationAndTeamData,
        );
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
    ) {
        const resolver = new ConfigResolver(codeReviewConfigs);

        const parentConfig = await resolver.getResolvedParentConfig(
            repositoryId,
            directoryId,
        );

        let oldConfig: CreateOrUpdateCodeReviewParameterDto['configValue'];
        let level: ConfigLevel;
        let repository: RepositoryCodeReviewConfig | undefined;
        let directory: DirectoryCodeReviewConfig | undefined;
        let isCreation = false;

        if (directoryId && repositoryId) {
            level = ConfigLevel.DIRECTORY;
            repository = resolver.findRepository(repositoryId);
            directory = resolver.findDirectory(repository, directoryId);
            oldConfig = directory.configs ?? {};
            isCreation = !directory.isSelected;
        } else if (repositoryId) {
            level = ConfigLevel.REPOSITORY;
            repository = resolver.findRepository(repositoryId);
            oldConfig = repository.configs ?? {};
            isCreation = !repository.isSelected;
        } else {
            level = ConfigLevel.GLOBAL;
            oldConfig = codeReviewConfigs.configs ?? {};
        }

        await this.processExternalReferencesInline(
            newConfigValue,
            organizationAndTeamData,
            repositoryId,
            directoryId,
            repository?.name ?? repositoryId ?? 'global',
        );

        const newResolvedConfig = deepMerge(
            parentConfig,
            oldConfig,
            newConfigValue,
        );

        const newDelta = deepDifference(parentConfig, newResolvedConfig);

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
        });

        return true;
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
                organizationId: this.request?.user?.organization?.uuid,
                userId: this.request?.user?.uuid,
                userEmail: this.request?.user?.email,
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
                error: error,
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
