import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { v4 as uuid } from 'uuid';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import { ValidateRuleFileReferencesUseCase } from './validate-rule-file-references.use-case';

/**
 * Triggered exclusively from authenticated HTTP requests
 * (apps/api/src/controllers/kodyRules.controller.ts) — `REQUEST` is
 * therefore safe to inject. Callers must not invoke this use case from
 * background jobs / event listeners; the existing PR-merge-triggered
 * sync uses `KodyRulesSyncService.syncRepositoryMain` directly.
 */
@Injectable()
export class ResyncRulesFromIdeUseCase {
    private readonly logger = createLogger(ResyncRulesFromIdeUseCase.name);
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
        repositoriesIds: string[];
        path?: string;
    }) {
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId: this.request.user?.organization?.uuid,
            teamId: params.teamId,
        };

        try {
            const repos = await this.codeManagementService.getRepositories({
                organizationAndTeamData,
            });

            if (!Array.isArray(repos) || repos.length === 0) {
                return;
            }

            const filtered = repos
                .filter(
                    (r: any) =>
                        r && (r.selected === true || r.isSelected === true),
                )
                .filter((r: any) =>
                    params.repositoriesIds && params.repositoriesIds.length > 0
                        ? params.repositoriesIds.includes(r.id) ||
                          params.repositoriesIds.includes(String(r.id))
                        : true,
                );

            for (const repo of filtered) {
                try {
                    await this.kodyRulesSyncService.syncRepositoryMain({
                        organizationAndTeamData,
                        repository: {
                            id: String(repo.id),
                            name: repo.name,
                            fullName:
                                (repo as any)?.fullName ||
                                `${(repo as any)?.organizationName || ''}/${repo.name}`,
                            defaultBranch: (repo as any)?.default_branch,
                        },
                        path: params.path,
                    });
                    await this.notifySynced(
                        organizationAndTeamData.organizationId,
                        repo.name,
                    );
                    // Validate external file references for this repo's
                    // rules; targeting rule owners so they can fix the
                    // references they own. Errors swallowed inside the
                    // validator so a failing check doesn't block the
                    // remaining repos.
                    await this.validateRuleFileReferences.execute({
                        organizationAndTeamData,
                        repository: {
                            id: String(repo.id),
                            name: repo.name,
                        },
                        source: 'manual',
                    });
                } catch (perRepoError) {
                    // Per-repo failure: notify and continue with other
                    // repos rather than aborting the whole resync.
                    this.logger.error({
                        message: `Failed to resync repository ${repo.name}`,
                        context: ResyncRulesFromIdeUseCase.name,
                        error: perRepoError,
                    });
                    await this.notifySyncFailed(
                        organizationAndTeamData.organizationId,
                        repo.name,
                        perRepoError instanceof Error
                            ? perRepoError.message
                            : String(perRepoError),
                    );
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to sync selected repositories Kody Rules',
                context: ResyncRulesFromIdeUseCase.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    params,
                },
            });
            await this.notifySyncFailed(
                organizationAndTeamData.organizationId,
                'multiple repositories',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async notifySynced(
        organizationId: string,
        repoName: string,
    ): Promise<void> {
        try {
            const userId = this.request.user?.uuid;
            if (!userId) return;
            await this.notificationService.emit({
                event: NotificationEvent.IDE_RULES_SYNCED,
                payload: {
                    repoName: repoName ?? '',
                    // We don't have a final rules-count for this code
                    // path (syncRepositoryMain returns void). Use 0 to
                    // mean "synced" rather than make up a number — the
                    // in-app template handles 0 gracefully ("Rules
                    // synced from {repo}").
                    rulesCount: 0,
                    syncMode: 'full',
                },
                organizationId,
                recipients: { kind: 'user', userId },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to emit ide.rules_synced notification',
                error: error instanceof Error ? error : new Error(String(error)),
                context: ResyncRulesFromIdeUseCase.name,
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
                context: ResyncRulesFromIdeUseCase.name,
            });
        }
    }
}
