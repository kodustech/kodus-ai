import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { produce } from 'immer';

import { createLogger } from '@kodus/flow';
import {
    CentralizedConfigPrService,
    CentralizedPrMetadata,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { DeleteByRepositoryOrDirectoryPullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/delete-by-repository-or-directory.use-case';
import { buildKodyRuleCentralizedFilePath } from '@libs/centralized-config/utils/kody-rules-centralized-pr.builder';
import { buildKodusConfigCentralizedMutationRequest } from '@libs/centralized-config/utils/kodus-config-centralized-pr.builder';
import { buildGroupFolderName } from '@libs/centralized-config/utils/path-encoder';
import { ParametersKey } from '@libs/core/domain/enums';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { RepositoryWithDirectoriesException } from '@libs/core/infrastructure/filters';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    IKodyRule,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';
import { DeleteRepositoryCodeReviewParameterDto } from '@libs/organization/dtos/delete-repository-code-review-parameter.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class DeleteRepositoryCodeReviewParameterUseCase {
    private readonly logger = createLogger(
        DeleteRepositoryCodeReviewParameterUseCase.name,
    );
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,

        private readonly eventEmitter: EventEmitter2,

        private readonly deletePullRequestMessagesUseCase: DeleteByRepositoryOrDirectoryPullRequestMessagesUseCase,

        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly centralizedConfigPrService: CentralizedConfigPrService,
    ) {}

    async execute(
        body: DeleteRepositoryCodeReviewParameterDto & {
            organizationAndTeamData?: OrganizationAndTeamData;
            actor?: {
                source?: 'cli' | 'web' | 'sync';
                organizationId?: string;
                userId?: string;
                userEmail?: string;
            };
        },
    ): Promise<
        | ParametersEntity<ParametersKey.CODE_REVIEW_CONFIG>
        | boolean
        | CentralizedPrMetadata
    > {
        const { teamId, repositoryId, directoryId } = body;

        try {
            const organizationId =
                body.organizationAndTeamData?.organizationId ??
                body.actor?.organizationId ??
                this.request?.user?.organization?.uuid;

            if (!organizationId) {
                throw new Error('Organization ID not found');
            }

            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId: body.organizationAndTeamData?.teamId ?? teamId,
            };

            const codeReviewConfigParam =
                await this.parametersService.findByKey(
                    ParametersKey.CODE_REVIEW_CONFIG,
                    organizationAndTeamData,
                );

            if (!codeReviewConfigParam || !codeReviewConfigParam.configValue) {
                throw new Error('Code review config not found');
            }

            // Structural change (removing a scope) is symmetric with the
            // selection-only add-directory flow: we mutate the DB right away
            // so the UI reflects the removal, and the centralized PR is a
            // best-effort side effect to clean up the repo. Waiting for the
            // PR merge would force the user into "delete → close PR → resync"
            // every time, which doesn't match how add works.
            let centralizedPr: CentralizedPrMetadata | null = null;
            if (body.actor?.source !== 'sync') {
                try {
                    centralizedPr =
                        await this.createCentralizedDeleteMutationIfEnabled({
                            organizationAndTeamData,
                            codeReviewConfig:
                                codeReviewConfigParam.configValue,
                            repositoryId,
                            directoryId,
                        });
                } catch (error) {
                    this.logger.warn({
                        message:
                            'Failed to open centralized PR for scope removal; continuing with DB removal',
                        context:
                            DeleteRepositoryCodeReviewParameterUseCase.name,
                        error: this.normalizeError(error),
                        metadata: {
                            body,
                        },
                    });
                }
            }

            const codeReviewConfig = codeReviewConfigParam.configValue;
            let result:
                | ParametersEntity<ParametersKey.CODE_REVIEW_CONFIG>
                | boolean;

            if (repositoryId && directoryId && body.folderId) {
                result = await this.removeFolderFromGroup(
                    organizationAndTeamData,
                    codeReviewConfig,
                    repositoryId,
                    directoryId,
                    body.folderId,
                    body.actor,
                );
            } else if (repositoryId && directoryId) {
                result = await this.deleteDirectoryConfig(
                    organizationAndTeamData,
                    codeReviewConfig,
                    repositoryId,
                    directoryId,
                    body.actor,
                );
            } else if (repositoryId) {
                result = await this.deleteRepositoryConfig(
                    organizationAndTeamData,
                    codeReviewConfig,
                    repositoryId,
                    body.actor,
                );
            } else {
                throw new Error('RepositoryId is required');
            }

            // If a centralized PR was opened, surface its metadata to the
            // caller so the UI can link to it; otherwise return the raw DB
            // mutation result.
            return centralizedPr ?? result;
        } catch (error) {
            this.logger.error({
                message: 'Could not delete code review configuration',
                context: DeleteRepositoryCodeReviewParameterUseCase.name,
                error: this.normalizeError(error),
                metadata: { body },
            });
            throw error;
        }
    }

    private normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    private async createCentralizedDeleteMutationIfEnabled(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        codeReviewConfig: CodeReviewParameter;
        repositoryId?: string;
        directoryId?: string;
    }): Promise<CentralizedPrMetadata | null> {
        const { organizationAndTeamData, repositoryId, directoryId } = params;

        if (!repositoryId) {
            return null;
        }

        const repository = params.codeReviewConfig.repositories.find(
            (repo) => repo.id === repositoryId,
        );

        if (!repository) {
            return null;
        }

        const directory = directoryId
            ? repository.directories?.find((dir) => dir.id === directoryId)
            : undefined;

        const rulesForScope = await this.getRulesForCentralizedDeleteScope({
            organizationId: organizationAndTeamData.organizationId,
            repositoryId,
            directoryId,
        });

        const scopeConfigs = directory ? directory.configs : repository.configs;
        const hasScopeConfig = this.hasMeaningfulConfigValues(scopeConfigs);

        if (!hasScopeConfig && rulesForScope.length === 0) {
            return null;
        }

        const isDirectoryGroup =
            directory &&
            !!directory.folders &&
            directory.folders.length > 0;

        const baseRequest = buildKodusConfigCentralizedMutationRequest({
            centralizedConfigPrService: this.centralizedConfigPrService,
            organizationAndTeamData,
            repositoryId,
            directoryPath: isDirectoryGroup
                ? undefined
                : directory?.folders?.[0]?.path,
            folders: isDirectoryGroup ? directory?.folders : undefined,
            configFileContent: null,
            title: `Remove Kodus config for ${repository.name}${directory ? ` (${directory.name ?? directory.folders?.[0]?.path ?? ''})` : ''}`,
            description:
                'This pull request proposes removing a code review scope configuration from centralized config.',
            commitMessage: `remove code review config for ${repository.name}`,
            sourceBranchPrefix: 'kodus-centralized-config-delete',
            centralizedModeMessage:
                'Centralized config is enabled. Code review settings removal proposed through a pull request.',
        });

        const pr =
            await this.centralizedConfigPrService.createMutationPullRequestIfEnabled(
                {
                    ...baseRequest,
                    files: ({ repositoryFolder }) => {
                        const configFileDeletes = Array.isArray(
                            baseRequest.files,
                        )
                            ? baseRequest.files
                            : baseRequest.files({ repositoryFolder });

                        const groupFolderNamesByDirId =
                            this.buildGroupFolderNameMap(repository);
                        const ruleFileDeletes = this.getRuleDeleteFileChanges(
                            rulesForScope,
                            repositoryFolder,
                            groupFolderNamesByDirId,
                        );

                        return [...configFileDeletes, ...ruleFileDeletes];
                    },
                },
            );

        if (pr.mode !== 'centralized-pr') {
            return null;
        }

        return pr;
    }

    private async getRulesForCentralizedDeleteScope(params: {
        organizationId: string;
        repositoryId: string;
        directoryId?: string;
    }): Promise<Partial<IKodyRule>[]> {
        const scopedRuleDocuments = await this.kodyRulesService.find({
            organizationId: params.organizationId,
            rules: [
                {
                    repositoryId: params.repositoryId,
                    ...(params.directoryId
                        ? { directoryId: params.directoryId }
                        : {}),
                },
            ],
        } as any);

        if (
            !Array.isArray(scopedRuleDocuments) ||
            scopedRuleDocuments.length === 0
        ) {
            return [];
        }

        return scopedRuleDocuments
            .flatMap((entity) => entity?.rules ?? [])
            .filter((rule): rule is Partial<IKodyRule> => {
                if (!rule || rule.repositoryId !== params.repositoryId) {
                    return false;
                }

                if (params.directoryId) {
                    return rule.directoryId === params.directoryId;
                }

                return true;
            });
    }

    private getRuleDeleteFileChanges(
        rulesForScope: Partial<IKodyRule>[],
        repositoryFolder: string,
        groupFolderNamesByDirId: Map<string, string>,
    ): Array<{ path: string; operation: 'delete' }> {
        const rulePaths = new Set<string>();

        for (const rule of rulesForScope) {
            if (!rule?.title) {
                continue;
            }

            const centralizedPath = buildKodyRuleCentralizedFilePath({
                centralizedConfigPrService: this.centralizedConfigPrService,
                repositoryFolder,
                rulesDirectory:
                    rule.type === KodyRulesType.MEMORY ? 'memories' : 'review',
                ruleContent: rule,
                groupFolderName: rule.directoryId
                    ? groupFolderNamesByDirId.get(String(rule.directoryId))
                    : undefined,
            });

            rulePaths.add(centralizedPath);
        }

        return Array.from(rulePaths).map((path) => ({
            path,
            operation: 'delete' as const,
        }));
    }

    private buildGroupFolderNameMap(
        repository: { directories?: Array<{ id?: string; folders?: Array<{ path: string }> }> },
    ): Map<string, string> {
        const map = new Map<string, string>();
        for (const dir of repository.directories ?? []) {
            if (!dir?.id || !dir.folders || dir.folders.length === 0) {
                continue;
            }
            try {
                map.set(
                    String(dir.id),
                    buildGroupFolderName(dir.folders.map((f) => f.path)),
                );
            } catch {
                // Skip groups with invalid path sets — they cannot be reached on disk.
            }
        }
        return map;
    }

    private hasMeaningfulConfigValues(
        configs?: Record<string, unknown>,
    ): boolean {
        if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
            return false;
        }

        for (const value of Object.values(configs)) {
            if (value === undefined || value === null) {
                continue;
            }

            if (Array.isArray(value)) {
                if (value.length > 0) {
                    return true;
                }

                continue;
            }

            if (typeof value === 'object') {
                if (
                    this.hasMeaningfulConfigValues(
                        value as Record<string, unknown>,
                    )
                ) {
                    return true;
                }

                continue;
            }

            return true;
        }

        return false;
    }

    private async deleteRepositoryConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        currentConfig: CodeReviewParameter,
        repositoryId: string,
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        const repositoryIndex = currentConfig.repositories.findIndex(
            (repo) => repo.id === repositoryId,
        );

        if (repositoryIndex === -1) {
            throw new Error('Repository not found in configuration');
        }

        const repositoryToRemove = currentConfig.repositories[repositoryIndex];

        if (repositoryToRemove.directories?.length > 0) {
            throw new RepositoryWithDirectoriesException();
        }

        const updatedConfig = produce(currentConfig, (draft) => {
            const repo = draft.repositories[repositoryIndex];
            repo.configs = {};
            repo.isSelected = false;
        });

        const updated = await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CODE_REVIEW_CONFIG,
            updatedConfig,
            organizationAndTeamData,
        );

        this.logger.log({
            message: 'Repository configuration reset successfully',
            context: DeleteRepositoryCodeReviewParameterUseCase.name,
            metadata: { repositoryId, organizationAndTeamData },
        });

        await this.handleRepositorySideEffects(
            organizationAndTeamData,
            repositoryToRemove,
            actor,
        );

        return updated;
    }

    private async deleteDirectoryConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        currentConfig: CodeReviewParameter,
        repositoryId: string,
        directoryId: string,
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        const repositoryIndex = currentConfig.repositories.findIndex(
            (repo) => repo.id === repositoryId,
        );
        if (repositoryIndex === -1) {
            throw new Error('Repository not found in configuration');
        }

        const repository = currentConfig.repositories[repositoryIndex];
        const directoryIndex = repository.directories?.findIndex(
            (dir) => dir.id === directoryId,
        );

        if (directoryIndex === undefined || directoryIndex === -1) {
            throw new Error('Directory not found in configuration');
        }

        const directoryToRemove = repository.directories[directoryIndex];

        const updatedConfig = produce(currentConfig, (draft) => {
            const repo = draft.repositories[repositoryIndex];
            repo.directories.splice(directoryIndex, 1);

        });

        const updated = await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CODE_REVIEW_CONFIG,
            updatedConfig,
            organizationAndTeamData,
        );

        this.logger.log({
            message:
                'Directory removed from repository configuration successfully',
            context: DeleteRepositoryCodeReviewParameterUseCase.name,
            metadata: { repositoryId, directoryId, organizationAndTeamData },
        });

        await this.handleDirectorySideEffects(
            organizationAndTeamData,
            repository,
            {
                id: directoryToRemove.id,
                path: directoryToRemove.folders?.[0]?.path,
            },
            actor,
        );

        return updated;
    }

    private async removeFolderFromGroup(
        organizationAndTeamData: OrganizationAndTeamData,
        currentConfig: CodeReviewParameter,
        repositoryId: string,
        directoryId: string,
        folderId: string,
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        const repositoryIndex = currentConfig.repositories.findIndex(
            (repo) => repo.id === repositoryId,
        );
        if (repositoryIndex === -1) {
            throw new Error('Repository not found in configuration');
        }

        const repository = currentConfig.repositories[repositoryIndex];
        const groupIndex = repository.directories?.findIndex(
            (dir) => dir.id === directoryId,
        );

        if (groupIndex === undefined || groupIndex === -1) {
            throw new Error('Directory group not found in configuration');
        }

        const group = repository.directories[groupIndex];

        // If group has only 1 folder, delete the entire group
        if (!group.folders || group.folders.length <= 1) {
            return this.deleteDirectoryConfig(
                organizationAndTeamData,
                currentConfig,
                repositoryId,
                directoryId,
                actor,
            );
        }

        const folderIndex = group.folders.findIndex((f) => f.id === folderId);
        if (folderIndex === -1) {
            throw new Error('Folder not found in directory group');
        }

        const updatedConfig = produce(currentConfig, (draft) => {
            const draftGroup =
                draft.repositories[repositoryIndex].directories[groupIndex];
            draftGroup.folders.splice(folderIndex, 1);
            // Update group name to first remaining folder
            draftGroup.name = draftGroup.folders[0]?.name ?? '';
        });

        const updated = await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CODE_REVIEW_CONFIG,
            updatedConfig,
            organizationAndTeamData,
        );

        this.logger.log({
            message:
                'Folder removed from directory group successfully',
            context: DeleteRepositoryCodeReviewParameterUseCase.name,
            metadata: {
                repositoryId,
                directoryId,
                folderId,
                organizationAndTeamData,
            },
        });

        return updated;
    }

    private async handleRepositorySideEffects(
        orgData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        await this.deletePullRequestMessagesUseCase.execute({
            organizationId: orgData.organizationId,
            repositoryId: repository.id,
        });

        await this.kodyRulesService.updateRulesStatusByFilter(
            orgData.organizationId,
            repository.id,
            undefined,
            KodyRulesStatus.DELETED,
        );

        const resolvedActor = this.resolveActor(actor);
        if (!resolvedActor) {
            return;
        }

        this.eventEmitter.emit(AuditLogEvents.REPOSITORY_CONFIG_REMOVAL, {
            organizationAndTeamData: orgData,
            userInfo: {
                userId: resolvedActor.userId,
                userEmail: resolvedActor.userEmail,
            },
            repository,
            actionType: ActionType.DELETE,
        });
    }

    private async handleDirectorySideEffects(
        orgData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        directory: { id: string; path?: string },
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        await this.deletePullRequestMessagesUseCase.execute({
            organizationId: orgData.organizationId,
            repositoryId: repository.id,
            directoryId: directory.id,
        });

        await this.kodyRulesService.updateRulesStatusByFilter(
            orgData.organizationId,
            repository.id,
            directory.id,
            KodyRulesStatus.DELETED,
        );

        const resolvedActor = this.resolveActor(actor);
        if (!resolvedActor) {
            return;
        }

        this.eventEmitter.emit(AuditLogEvents.DIRECTORY_CONFIG_REMOVAL, {
            organizationAndTeamData: orgData,
            userInfo: {
                userId: resolvedActor.userId,
                userEmail: resolvedActor.userEmail,
            },
            repository,
            directory,
            actionType: ActionType.DELETE,
        });
    }

    private resolveActor(actor?: {
        source?: 'cli' | 'web' | 'sync';
        organizationId?: string;
        userId?: string;
        userEmail?: string;
    }) {
        const resolvedActor = actor ?? {
            organizationId: this.request?.user?.organization?.uuid,
            userId: this.request?.user?.uuid,
            userEmail: this.request?.user?.email,
        };

        if (
            !resolvedActor.organizationId ||
            !resolvedActor.userId ||
            !resolvedActor.userEmail
        ) {
            return null;
        }

        return resolvedActor;
    }
}
