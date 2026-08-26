import { Inject, Injectable } from '@nestjs/common';
import { DeepPartial } from 'typeorm';

import { createLogger } from '@libs/core/log/logger';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IPromptExternalReferenceManagerService,
    PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN,
} from '@libs/ai-engine/domain/prompt/contracts/promptExternalReferenceManager.contract';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { ParametersKey } from '@libs/core/domain/enums';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IParameters } from '@libs/organization/domain/parameters/interfaces/parameters.interface';
import {
    FormattedCodeReviewConfig,
    FormattedConfigLevel,
    FormattedGlobalCodeReviewConfig,
    FormattedRepositoryCodeReviewConfig,
    IFormattedConfigProperty,
    KodusConfigFileOverlay,
    KodusConfigFileOverlayStatus,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import {
    buildDefaultGlobalCodeReviewConfig,
    getDefaultKodusConfigFile,
} from '@libs/common/utils/validateCodeReviewConfigFile';
import {
    CodeReviewConfigWithoutLLMProvider,
    KodusConfigFile,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PromptSourceType } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';

type CodeReviewRepositoryEntry = NonNullable<
    IParameters<ParametersKey.CODE_REVIEW_CONFIG>['configValue']['repositories']
>[number];

@Injectable()
export class GetCodeReviewParameterUseCase {
    private readonly logger = createLogger(GetCodeReviewParameterUseCase.name);

    /**
     * Upper bound on the provider calls a single repository's
     * `kodus-config.yml` overlay may spend. Repositories are formatted
     * concurrently, so this also bounds the endpoint as a whole. A healthy
     * read is ~400ms; 8s absorbs a short queue on the shared credential
     * without making the settings screen wait on a backlogged one.
     */
    private static readonly FILE_OVERLAY_TIMEOUT_MS = Number(
        process.env.KODUS_CONFIG_FILE_OVERLAY_TIMEOUT_MS ?? 8_000,
    );

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,

        private readonly authorizationService: AuthorizationService,

        @Inject(PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN)
        private readonly promptReferenceManager: IPromptExternalReferenceManagerService,
    ) {}

    async execute(
        user: Partial<IUser>,
        teamId: string,
        options: {
            skipAuthorization?: boolean;
            organizationId?: string;
            /**
             * Overlays each repository's `kodus-config.yml`, read live from the
             * git provider. Defaults to true so the CLI and centralized-config
             * callers keep the full merged view. The settings screen turns it
             * off for its blocking first render — the provider can be slow or
             * rate-limited, and the screen must not wait on it — then requests
             * the overlay again from the client.
             */
            includeFileOverlay?: boolean;
        } = {},
    ) {
        try {
            const organizationId =
                options.organizationId ?? user?.organization?.uuid;

            if (!organizationId) {
                throw new Error('User organization data is missing');
            }

            if (!teamId) {
                throw new Error('Team ID is required');
            }

            const organizationAndTeamData = {
                organizationId,
                teamId: teamId,
            };

            let parametersEntity = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            // A team can reach the code review settings screen without its
            // config row (created too late in onboarding, or a creation write
            // that failed silently). Get-or-create the default global config so
            // the page loads instead of erroring. Insert-if-absent returns the
            // active row (ours, or one a concurrent writer just created), so a
            // race surfaces the real config rather than a transient error.
            if (!parametersEntity) {
                parametersEntity =
                    await this.parametersService.createActiveVersionIfAbsent(
                        ParametersKey.CODE_REVIEW_CONFIG,
                        organizationAndTeamData.teamId,
                        buildDefaultGlobalCodeReviewConfig(),
                    );
            }

            if (!parametersEntity) {
                throw new Error('Code review parameters not found');
            }

            const parameters = parametersEntity.toObject();

            const filteredRepositories = [];
            for (const repo of parameters.configValue.repositories || []) {
                const hasPermission = options.skipAuthorization
                    ? true
                    : await this.authorizationService.check({
                          user,
                          action: Action.Read,
                          resource: ResourceType.CodeReviewSettings,
                          repoIds: [repo.id],
                      });

                if (hasPermission) {
                    filteredRepositories.push(repo);
                }
            }

            const hasPermissionParameters = {
                ...parameters,
                configValue: {
                    ...parameters.configValue,
                    repositories: filteredRepositories,
                },
            };

            const formattedConfigValue =
                await this.getCodeReviewConfigFormatted(
                    organizationAndTeamData,
                    hasPermissionParameters.configValue,
                    options.includeFileOverlay ?? true,
                );

            /**
             * TEMPORARY LOGIC: Show/hide code review version toggle based on user registration date
             *
             * Purpose: Gradually migrate users from legacy to v2 engine
             * - Users registered BEFORE 2025-09-11: Can see version toggle (legacy + v2)
             * - Users registered ON/AFTER 2025-09-11: Only see v2 (no toggle)
             *
             * This logic should be REMOVED after all clients migrate to v2 engine
             * TODO: Remove this temporary logic after client migration completion
             */
            const cutoffYear = 2025;
            const cutoffMonth = 8; // September (0-indexed)
            const cutoffDay = 11;

            // A row created by get-or-create above (or an older row that never
            // stored it) has no createdAt. Treat it as post-cutoff: the toggle
            // exists only to keep pre-cutoff teams on the legacy engine.
            const createdAt = hasPermissionParameters.createdAt
                ? new Date(hasPermissionParameters.createdAt)
                : null;

            const paramYear = createdAt?.getUTCFullYear();
            const paramMonth = createdAt?.getUTCMonth();
            const paramDay = createdAt?.getUTCDate();

            const showToggleCodeReviewVersion =
                createdAt !== null &&
                (paramYear < cutoffYear ||
                    (paramYear === cutoffYear && paramMonth < cutoffMonth) ||
                    (paramYear === cutoffYear &&
                        paramMonth === cutoffMonth &&
                        paramDay < cutoffDay));

            return {
                ...hasPermissionParameters,
                configValue: {
                    ...formattedConfigValue,
                    configs: {
                        ...formattedConfigValue.configs,
                        showToggleCodeReviewVersion,
                    },
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error fetching code review parameters',
                context: GetCodeReviewParameterUseCase.name,
                error: error,
                metadata: { user, teamId },
            });
            throw error;
        }
    }

    private async getCodeReviewConfigFormatted(
        organizationAndTeamData: OrganizationAndTeamData,
        configValue: IParameters<ParametersKey.CODE_REVIEW_CONFIG>['configValue'],
        includeFileOverlay: boolean,
    ): Promise<FormattedGlobalCodeReviewConfig> {
        const defaultConfig = getDefaultKodusConfigFile();
        const formattedDefaultConfig = this.formatDefaultConfig(defaultConfig);

        let formattedGlobalConfig = this.formatLevel(
            formattedDefaultConfig,
            configValue.configs,
            FormattedConfigLevel.GLOBAL,
        );

        // Buscar e adicionar referências externas do nível global
        const globalConfigKey = this.promptReferenceManager.buildConfigKey(
            organizationAndTeamData,
            'global',
        );
        formattedGlobalConfig = await this.enrichConfigWithExternalReferences(
            formattedGlobalConfig,
            globalConfigKey,
        );

        // Repositories are formatted concurrently: the provider calls behind
        // them are serialized upstream by the rate gate anyway, but running
        // them sequentially here meant one slow repository delayed — and one
        // failing repository could stall — every repository after it.
        const repositories = configValue.repositories || [];
        const settledRepositories = await Promise.allSettled(
            repositories.map((repo) =>
                this.formatRepository(
                    organizationAndTeamData,
                    formattedGlobalConfig,
                    repo,
                    includeFileOverlay,
                ),
            ),
        );

        const formattedRepositories = [];

        settledRepositories.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                formattedRepositories.push(result.value);
                return;
            }

            this.logger.warn({
                message:
                    'Skipping repository while formatting code review config due to repository-level error',
                context: GetCodeReviewParameterUseCase.name,
                error: result.reason,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    repositoryId: repositories[index]?.id,
                    repositoryName: repositories[index]?.name,
                },
            });
        });

        return {
            ...configValue,
            configs: formattedGlobalConfig as any, // TODO: remove this 'any' once migration is done
            repositories: formattedRepositories,
        };
    }

    /**
     * Formats one repository and its directories. Reading `kodus-config.yml`
     * means a live call to the git provider, so every such call is bounded by
     * a single deadline shared across this repository: when the provider is
     * slow or throttled the repository still renders from stored config, with
     * `kodusConfigFile.status` telling the caller the overlay is missing.
     * Dropping the repository instead would hide it from the settings screen.
     */
    private async formatRepository(
        organizationAndTeamData: OrganizationAndTeamData,
        formattedGlobalConfig: FormattedCodeReviewConfig,
        repo: CodeReviewRepositoryEntry,
        includeFileOverlay: boolean,
    ): Promise<FormattedRepositoryCodeReviewConfig> {
        const repository = { id: repo.id, name: repo.name };
        const directories = repo.directories || [];

        const repoOverride =
            repo.configs?.kodusConfigFileOverridesWebPreferences ?? false;
        const overrideForDirectory = (dir: (typeof directories)[number]) =>
            dir.configs?.kodusConfigFileOverridesWebPreferences ?? repoOverride;

        const wantsFile =
            includeFileOverlay &&
            (repoOverride || directories.some(overrideForDirectory));

        // One budget for this repository's provider calls as a whole. Since
        // repositories run concurrently, the request's worst case is a single
        // budget rather than one per repository or per directory.
        const deadlineAt =
            Date.now() + GetCodeReviewParameterUseCase.FILE_OVERLAY_TIMEOUT_MS;

        // Resolved once and threaded into every getKodusConfigFile call below.
        // Left to itself, each call re-asks the provider for the same branch —
        // one extra round trip per directory, on the credential already under
        // pressure.
        let defaultBranch: string | undefined;
        let branchError: string | undefined;

        if (wantsFile) {
            try {
                defaultBranch = await this.withDeadline(
                    this.codeBaseConfigService.getDefaultBranch(
                        organizationAndTeamData,
                        repository,
                    ),
                    deadlineAt,
                );
            } catch (error) {
                branchError = this.getErrorMessage(error);
                this.logger.warn({
                    message:
                        'Could not resolve default branch; rendering repository without its kodus-config.yml overlay',
                    context: GetCodeReviewParameterUseCase.name,
                    error,
                    metadata: {
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                        repositoryId: repo.id,
                        repositoryName: repo.name,
                    },
                });
            }
        }

        const readKodusConfigFile = async (
            scope: { directoryPath?: string; directoryId?: string },
            overrideConfig: boolean,
            logMetadata: Record<string, unknown>,
        ): Promise<{
            file?: KodusConfigFile;
            overlay: KodusConfigFileOverlay;
        }> => {
            // DISABLED is decided from stored config alone, so it is reported
            // even when the overlay is skipped: the caller needs to tell "this
            // scope is not governed by a file" from "the file has not been
            // read yet".
            if (!overrideConfig) {
                return {
                    overlay: { status: KodusConfigFileOverlayStatus.DISABLED },
                };
            }

            if (!includeFileOverlay) {
                return {
                    overlay: { status: KodusConfigFileOverlayStatus.SKIPPED },
                };
            }

            if (!defaultBranch) {
                return {
                    overlay: {
                        status: KodusConfigFileOverlayStatus.UNAVAILABLE,
                        error: branchError,
                    },
                };
            }

            try {
                const file =
                    await this.withDeadline(
                        this.codeBaseConfigService.getKodusConfigFile({
                            organizationAndTeamData,
                            repository,
                            defaultBranch,
                            overrideConfig: true,
                            ...scope,
                        }),
                        deadlineAt,
                    );

                return {
                    file,
                    overlay: { status: KodusConfigFileOverlayStatus.LOADED },
                };
            } catch (error) {
                this.logger.warn({
                    message:
                        'Could not read kodus-config.yml; rendering stored config without the file overlay',
                    context: GetCodeReviewParameterUseCase.name,
                    error,
                    metadata: {
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                        repositoryId: repo.id,
                        repositoryName: repo.name,
                        ...logMetadata,
                    },
                });

                return {
                    overlay: {
                        status: KodusConfigFileOverlayStatus.UNAVAILABLE,
                        error: this.getErrorMessage(error),
                    },
                };
            }
        };

        const repoFileResult = await readKodusConfigFile({}, repoOverride, {});

        const formattedRepoConfig = this.formatLevel(
            formattedGlobalConfig,
            repo.configs,
            FormattedConfigLevel.REPOSITORY,
        );

        let formattedRepoFileConfig = this.formatLevel(
            formattedRepoConfig,
            repoFileResult.file,
            FormattedConfigLevel.REPOSITORY_FILE,
        );

        // Buscar e adicionar referências externas do nível repositório
        const repoConfigKey = this.promptReferenceManager.buildConfigKey(
            organizationAndTeamData,
            repo.id,
        );
        formattedRepoFileConfig = await this.enrichConfigWithExternalReferences(
            formattedRepoFileConfig,
            repoConfigKey,
        );

        const settledDirectories = await Promise.allSettled(
            directories.map(async (dir) => {
                const isDirectoryGroup =
                    Array.isArray(dir.folders) && dir.folders.length > 0;

                const directoryFileResult = await readKodusConfigFile(
                    isDirectoryGroup
                        ? { directoryId: dir.id }
                        : { directoryPath: (dir as any).path },
                    overrideForDirectory(dir),
                    {
                        directoryId: dir.id,
                        directoryPath: dir.folders?.[0]?.path,
                    },
                );

                const formattedDirConfig = this.formatLevel(
                    formattedRepoFileConfig,
                    dir.configs,
                    FormattedConfigLevel.DIRECTORY,
                );

                let formattedDirFileConfig = this.formatLevel(
                    formattedDirConfig,
                    directoryFileResult.file,
                    FormattedConfigLevel.DIRECTORY_FILE,
                );

                // Buscar e adicionar referências externas do nível diretório
                const dirConfigKey =
                    this.promptReferenceManager.buildConfigKey(
                        organizationAndTeamData,
                        repo.id,
                        dir.id,
                    );
                formattedDirFileConfig =
                    await this.enrichConfigWithExternalReferences(
                        formattedDirFileConfig,
                        dirConfigKey,
                    );

                return {
                    ...dir,
                    configs: formattedDirFileConfig,
                    kodusConfigFile: directoryFileResult.overlay,
                };
            }),
        );

        const formattedDirectories = [];

        settledDirectories.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                formattedDirectories.push(result.value);
                return;
            }

            this.logger.warn({
                message:
                    'Skipping directory while formatting code review config due to directory-level error',
                context: GetCodeReviewParameterUseCase.name,
                error: result.reason,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    repositoryId: repo.id,
                    directoryId: directories[index]?.id,
                    directoryPath: directories[index]?.folders?.[0]?.path,
                },
            });
        });

        return {
            ...repo,
            configs: formattedRepoFileConfig,
            directories: formattedDirectories,
            kodusConfigFile: repoFileResult.overlay,
        };
    }

    /**
     * Bounds a provider call by a deadline shared across the caller's scope.
     * The call itself keeps running once the deadline fires — nothing below
     * this layer exposes cancellation — but the response stops waiting on it.
     */
    private async withDeadline<T>(
        promise: Promise<T>,
        deadlineAt: number,
    ): Promise<T> {
        const remainingMs = deadlineAt - Date.now();

        if (remainingMs <= 0) {
            throw new Error('kodus-config.yml overlay budget exhausted');
        }

        let timer: NodeJS.Timeout;

        try {
            return await Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `kodus-config.yml overlay timed out after ${remainingMs}ms`,
                                ),
                            ),
                        remainingMs,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private formatDefaultConfig(config: object): FormattedCodeReviewConfig {
        const formatted = {};
        for (const key in config) {
            if (Object.prototype.hasOwnProperty.call(config, key)) {
                const value = config[key];
                if (
                    typeof value === 'object' &&
                    value !== null &&
                    !Array.isArray(value)
                ) {
                    formatted[key] = this.formatDefaultConfig(value);
                } else {
                    formatted[key] = {
                        value,
                        level: FormattedConfigLevel.DEFAULT,
                    };
                }
            }
        }
        return formatted as FormattedCodeReviewConfig;
    }

    private formatLevel(
        formattedParent: FormattedCodeReviewConfig,
        childDelta: DeepPartial<CodeReviewConfigWithoutLLMProvider> | undefined,
        childLevel: FormattedConfigLevel,
    ): FormattedCodeReviewConfig {
        if (!childDelta) {
            return formattedParent;
        }

        const formattedChild = { ...formattedParent };

        for (const key in childDelta) {
            if (Object.prototype.hasOwnProperty.call(childDelta, key)) {
                const childValue = childDelta[key];
                const parentNode = formattedParent[key];

                if (
                    typeof childValue === 'object' &&
                    childValue !== null &&
                    !Array.isArray(childValue) &&
                    parentNode
                ) {
                    formattedChild[key] = this.formatLevel(
                        parentNode,
                        childValue,
                        childLevel,
                    );
                } else {
                    formattedChild[key] = {
                        value: childValue,
                        level: childLevel,
                        overriddenValue: (
                            parentNode as IFormattedConfigProperty<any>
                        )?.value,
                        overriddenLevel: (
                            parentNode as IFormattedConfigProperty<any>
                        )?.level,
                    };
                }
            }
        }
        return formattedChild;
    }

    private async enrichConfigWithExternalReferences(
        config: FormattedCodeReviewConfig,
        configKey: string,
    ): Promise<FormattedCodeReviewConfig> {
        const enriched = structuredClone(config);
        const contextReferenceId =
            this.extractContextReferenceIdFromFormattedConfig(config);

        if (enriched.summary?.customInstructions) {
            const ref = await this.promptReferenceManager.getReference(
                configKey,
                PromptSourceType.CUSTOM_INSTRUCTION,
                { contextReferenceId },
            );
            if (ref) {
                enriched.summary.customInstructions = {
                    ...enriched.summary.customInstructions,
                    externalReferences: {
                        references: ref.references,
                        syncErrors: ref.syncErrors || [],
                        processingStatus: ref.processingStatus,
                        lastProcessedAt: ref.lastProcessedAt,
                    },
                };
            }
        }

        if (enriched.v2PromptOverrides) {
            const categories = ['bug', 'performance', 'security'] as const;
            const severities = ['critical', 'high', 'medium', 'low'] as const;

            const sourceTypesToFetch: PromptSourceType[] = [];

            if (enriched.v2PromptOverrides.categories?.descriptions) {
                categories
                    .filter(
                        (category) =>
                            enriched.v2PromptOverrides.categories.descriptions[
                                category
                            ],
                    )
                    .forEach((category) => {
                        sourceTypesToFetch.push(
                            `category_${category}` as PromptSourceType,
                        );
                    });
            }

            if (enriched.v2PromptOverrides.severity?.flags) {
                severities
                    .filter(
                        (severity) =>
                            enriched.v2PromptOverrides.severity.flags[severity],
                    )
                    .forEach((severity) => {
                        sourceTypesToFetch.push(
                            `severity_${severity}` as PromptSourceType,
                        );
                    });
            }

            if (enriched.v2PromptOverrides.generation?.main) {
                sourceTypesToFetch.push(PromptSourceType.GENERATION_MAIN);
            }

            const referencesMap =
                await this.promptReferenceManager.getMultipleReferences(
                    configKey,
                    sourceTypesToFetch,
                    { contextReferenceId },
                );

            if (enriched.v2PromptOverrides.categories?.descriptions) {
                for (const category of categories) {
                    if (
                        enriched.v2PromptOverrides.categories.descriptions[
                            category
                        ]
                    ) {
                        const ref = referencesMap.get(
                            `category_${category}` as PromptSourceType,
                        );
                        if (ref) {
                            enriched.v2PromptOverrides.categories.descriptions[
                                category
                            ] = {
                                ...enriched.v2PromptOverrides.categories
                                    .descriptions[category],
                                externalReferences: {
                                    references: ref.references,
                                    syncErrors: ref.syncErrors || [],
                                    processingStatus: ref.processingStatus,
                                    lastProcessedAt: ref.lastProcessedAt,
                                },
                            };
                        }
                    }
                }
            }

            if (enriched.v2PromptOverrides.severity?.flags) {
                for (const severity of severities) {
                    if (enriched.v2PromptOverrides.severity.flags[severity]) {
                        const ref = referencesMap.get(
                            `severity_${severity}` as PromptSourceType,
                        );
                        if (ref) {
                            enriched.v2PromptOverrides.severity.flags[
                                severity
                            ] = {
                                ...enriched.v2PromptOverrides.severity.flags[
                                    severity
                                ],
                                externalReferences: {
                                    references: ref.references,
                                    syncErrors: ref.syncErrors || [],
                                    processingStatus: ref.processingStatus,
                                    lastProcessedAt: ref.lastProcessedAt,
                                },
                            };
                        }
                    }
                }
            }

            if (enriched.v2PromptOverrides.generation?.main) {
                const ref = referencesMap.get(PromptSourceType.GENERATION_MAIN);
                if (ref) {
                    enriched.v2PromptOverrides.generation.main = {
                        ...enriched.v2PromptOverrides.generation.main,
                        externalReferences: {
                            references: ref.references,
                            syncErrors: ref.syncErrors || [],
                            processingStatus: ref.processingStatus,
                            lastProcessedAt: ref.lastProcessedAt,
                        },
                    };
                }
            }
        }

        return enriched;
    }

    private extractContextReferenceIdFromFormattedConfig(
        config: FormattedCodeReviewConfig,
    ): string | undefined {
        const entry = config?.contextReferenceId as
            | IFormattedConfigProperty<string>
            | undefined;
        if (entry && typeof entry.value === 'string') {
            const trimmed = entry.value.trim();
            return trimmed.length ? trimmed : undefined;
        }
        return undefined;
    }
}
