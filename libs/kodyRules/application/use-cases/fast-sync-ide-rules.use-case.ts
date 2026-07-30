import { createLogger } from '@libs/core/log/logger';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { v4 as uuid } from 'uuid';

import { ValidateRuleFileReferencesUseCase } from './validate-rule-file-references.use-case';

/**
 * Triggered exclusively from authenticated HTTP requests
 * (apps/api/src/controllers/kodyRules.controller.ts) — `REQUEST` is
 * therefore safe to inject. Callers must not invoke this use case from
 * background jobs / event listeners; the existing PR-merge-triggered
 * sync uses `KodyRulesSyncService.syncRepositoryMain` directly.
 */
@Injectable()
export class FastSyncIdeRulesUseCase {
    private readonly logger = createLogger(FastSyncIdeRulesUseCase.name);

    constructor(
        private readonly kodyRulesSyncService: KodyRulesSyncService,
        private readonly codeManagementService: CodeManagementService,
        private readonly notificationService: NotificationService,
        private readonly validateRuleFileReferences: ValidateRuleFileReferencesUseCase,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    async execute(params: {
        teamId: string;
        repositoryId: string;
        maxFiles?: number;
        maxFileSizeBytes?: number;
        maxTotalBytes?: number;
        maxConcurrent?: number;
    }) {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID not found');
        }

        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId,
            teamId: params.teamId,
        };

        try {
            const repositories =
                await this.codeManagementService.getRepositories({
                    organizationAndTeamData,
                });

            const repository = (repositories || []).find(
                (repo: any) =>
                    repo?.id === params.repositoryId ||
                    repo?.id === Number(params.repositoryId) ||
                    repo?.id === String(params.repositoryId),
            );

            if (!repository) {
                throw new Error('Repository not found');
            }

            const result = await this.kodyRulesSyncService.syncRepositoryMainFast({
                organizationAndTeamData,
                repository: {
                    id: String(repository.id),
                    name: repository.name,
                    fullName:
                        (repository as any)?.fullName ||
                        `${(repository as any)?.organizationName || ''}/${repository.name}`,
                    defaultBranch: (repository as any)?.default_branch,
                },
                maxFiles: params.maxFiles,
                maxFileSizeBytes: params.maxFileSizeBytes,
                maxTotalBytes: params.maxTotalBytes,
                maxConcurrent: params.maxConcurrent,
            });

            await this.notifySynced(
                organizationId,
                repository?.name as string,
                Array.isArray((result as any)?.rules)
                    ? (result as any).rules.length
                    : 0,
            );

            // Validate external file references against the repo's current
            // state. Failure is logged and swallowed inside the validator
            // so the sync result still reaches the caller.
            await this.validateRuleFileReferences.execute({
                organizationAndTeamData,
                repository: {
                    id: String(repository.id),
                    name: repository.name,
                },
                source: 'ide',
                syncInitiatorUserId: this.request.user?.uuid,
            });

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Failed to fast sync IDE rules',
                context: FastSyncIdeRulesUseCase.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    params,
                },
            });

            await this.notifySyncFailed(
                organizationId,
                params.repositoryId,
                error instanceof Error ? error.message : String(error),
            );

            throw error;
        }
    }

    private async notifySynced(
        organizationId: string,
        repoName: string,
        rulesCount: number,
    ): Promise<void> {
        try {
            const userId = this.request.user?.uuid;
            if (!userId) return;
            await this.notificationService.emit({
                event: NotificationEvent.IDE_RULES_SYNCED,
                payload: {
                    repoName: repoName ?? '',
                    rulesCount,
                    syncMode: 'fast',
                },
                organizationId,
                recipients: { kind: 'user', userId },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to emit ide.rules_synced notification',
                error: error instanceof Error ? error : new Error(String(error)),
                context: FastSyncIdeRulesUseCase.name,
            });
        }
    }

    private async notifySyncFailed(
        organizationId: string,
        repoName: string,
        reason: string,
    ): Promise<void> {
        try {
            // Owners are the config-driven audience (defaultRoles); only the
            // sync initiator is passed as a directed recipient.
            const userId = this.request.user?.uuid;
            const recipients: Array<{ kind: 'user'; userId: string }> = [];
            if (userId) recipients.push({ kind: 'user', userId });

            await this.notificationService.emit({
                event: NotificationEvent.IDE_RULES_SYNC_FAILED,
                payload: {
                    repoName: repoName ?? '',
                    reason,
                    correlationId: uuid(),
                },
                organizationId,
                recipients,
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to emit ide.rules_sync_failed notification',
                error: error instanceof Error ? error : new Error(String(error)),
                context: FastSyncIdeRulesUseCase.name,
            });
        }
    }
}
