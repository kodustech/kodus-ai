import {
    ParametersKey,
    OrganizationParametersKey,
} from '@libs/core/domain/enums';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { GlobalRulesSourceConfig } from '@libs/kodyRules/domain/interfaces/global-rules-source.interface';
import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PullRequestClosedEvent } from '@libs/core/domain/events/pull-request-closed.event';
import { KodyRulesSyncService } from '../services/kodyRulesSync.service';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { createLogger } from '@libs/core/log/logger';
import {
    IDE_RULES_SYNC_DISABLED_EVENT,
    IdeRulesSyncDisabledEvent,
} from '@libs/kodyRules/domain/events/ide-rules-sync.events';

// Advisory-lock TTL: 5 min covers the worst observed sync (large repo +
// global scan + LLM per file). If a process crashes mid-sync the lock is
// released either by the TTL or by pg dropping the pinned session — a
// redelivery retry then re-acquires and re-runs.
const SYNC_LOCK_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class KodyRulesSyncListener {
    private readonly logger = createLogger(KodyRulesSyncListener.name);

    constructor(
        private readonly kodyRulesSyncService: KodyRulesSyncService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    /**
     * Whether the repo where this PR merged is a configured source of GLOBAL
     * rules. When true, merged changes to its rule files must also refresh the
     * org-wide global scope.
     */
    private async isGlobalSourceRepo(
        event: PullRequestClosedEvent,
    ): Promise<boolean> {
        try {
            const parameter =
                await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.GLOBAL_RULES_SOURCE_REPOSITORIES,
                    event.organizationAndTeamData,
                );
            const config = parameter?.configValue as
                GlobalRulesSourceConfig | undefined;
            return (config?.repositories ?? []).some(
                (r) => String(r.id) === String(event.repository.id),
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to check global-rules source membership',
                context: KodyRulesSyncListener.name,
                error,
                metadata: {
                    organizationAndTeamData: event.organizationAndTeamData,
                    repositoryId: event.repository?.id,
                },
            });
            return false;
        }
    }

    @OnEvent('pull-request.closed')
    async handlePullRequestClosedEvent(event: PullRequestClosedEvent) {
        if (!event.repository || !event.repository.id) {
            this.logger.warn({
                message:
                    'Received pull-request.closed event without repository information, skipping Kody rules sync',
                context: KodyRulesSyncListener.name,
                metadata: {
                    pullRequestNumber: event.pullRequestNumber,
                },
            });
            return;
        }

        if (!event.merged) {
            this.logger.log({
                message:
                    'Received non-merged pull-request.closed event, skipping Kody rules sync',
                context: KodyRulesSyncListener.name,
                metadata: {
                    pullRequestNumber: event.pullRequestNumber,
                    repositoryId: event.repository.id,
                },
            });
            return;
        }

        if (await this.isCentralizedConfigRepo(event)) {
            this.logger.log({
                message:
                    'Pull request closed in centralized config repository, skipping Kody rules sync',
                context: KodyRulesSyncListener.name,
                metadata: {
                    pullRequestNumber: event.pullRequestNumber,
                    repositoryId: event.repository.id,
                },
            });
            return;
        }

        this.logger.log({
            message: 'Handling pull-request.closed event for Kody Rules Sync',
            context: KodyRulesSyncListener.name,
            metadata: {
                prNumber: event.pullRequestNumber,
                repositoryId: event.repository.id,
            },
        });

        if (!event.files || event.files.length === 0) {
            return;
        }

        // Cross-process idempotency via pg_try_advisory_lock. The
        // pull-request.closed event reaches every process that hosts
        // this listener (local emit in the webhook consumer +
        // CrossProcessEventsBridge re-emits elsewhere); without a
        // shared claim they'd all import the same files concurrently
        // and produce DUPLICATE rules (observed live: two identical
        // rules from one merge). First acquirer wins; the others get
        // null and skip. Auto-release on TTL or on error via
        // try/finally, so a redelivery retry can re-run.
        const lockKey = `KODY_RULES:SYNC:${event.organizationAndTeamData?.organizationId}:${event.repository.id}:${event.pullRequestNumber}`;
        const lock = await this.distributedLockService.acquire(lockKey, {
            ttl: SYNC_LOCK_TTL_MS,
        });

        if (!lock) {
            this.logger.log({
                message:
                    'Sync already claimed by another process for this merge — skipping duplicate run',
                context: KodyRulesSyncListener.name,
                metadata: {
                    lockKey,
                    prNumber: event.pullRequestNumber,
                },
            });
            return;
        }

        try {
            await this.kodyRulesSyncService.syncFromChangedFiles({
                organizationAndTeamData: event.organizationAndTeamData,
                repository: event.repository,
                pullRequestNumber: event.pullRequestNumber,
                files: event.files,
            });

            // If this repo is also a global-rules source, refresh the global
            // scope. Full scan is fine — the per-file SHA short-circuit skips
            // unchanged files, so unrelated merges are cheap.
            if (await this.isGlobalSourceRepo(event)) {
                await this.kodyRulesSyncService.syncRepositoryGlobal({
                    organizationAndTeamData: event.organizationAndTeamData,
                    repository: event.repository,
                });
            }
        } finally {
            // DistributedLock.release() logs a failed pg_advisory_unlock and
            // then rethrows it. Letting that escape from `finally` would
            // either mask the sync error that got us here or turn a
            // successful sync into a rejected handler — and for this
            // listener a rejected handler means redelivery, which is exactly
            // the duplicate-rules failure the lock exists to prevent. The
            // pinned connection is already back in the pool by that point,
            // and the TTL (or session teardown) frees the advisory lock.
            await lock.release().catch(() => undefined);
        }
    }

    @OnEvent(IDE_RULES_SYNC_DISABLED_EVENT)
    async handleIdeRulesSyncDisabled(
        event: IdeRulesSyncDisabledEvent,
    ): Promise<void> {
        if (!event?.repositoryId) {
            this.logger.warn({
                message:
                    'Received ide-rules-sync.disabled event without repositoryId, skipping',
                context: KodyRulesSyncListener.name,
                metadata: { event },
            });
            return;
        }

        // Action defaults to 'keep' (least destructive) when missing — matches
        // the use-case behaviour for callers that don't pass it explicitly.
        const action = event.action ?? 'keep';

        this.logger.log({
            message: `Handling ide-rules-sync.disabled event with action=${action}`,
            context: KodyRulesSyncListener.name,
            metadata: {
                repositoryId: event.repositoryId,
                organizationAndTeamData: event.organizationAndTeamData,
                action,
            },
        });

        switch (action) {
            case 'keep':
                // No-op: the user only stopped automatic re-imports. Rules
                // stay ACTIVE.
                return;
            case 'pause':
                await this.kodyRulesSyncService.pauseAllIdeSyncRulesForRepository(
                    {
                        organizationAndTeamData: event.organizationAndTeamData,
                        repositoryId: event.repositoryId,
                    },
                );
                return;
            case 'delete':
                await this.kodyRulesSyncService.purgeAllIdeSyncRulesForRepository(
                    {
                        organizationAndTeamData: event.organizationAndTeamData,
                        repositoryId: event.repositoryId,
                    },
                );
                return;
        }
    }

    private async isCentralizedConfigRepo(
        event: PullRequestClosedEvent,
    ): Promise<boolean> {
        try {
            const centralizedConfigParameter =
                await this.parametersService.findByKey(
                    ParametersKey.CENTRALIZED_CONFIG,
                    event.organizationAndTeamData,
                );

            if (
                !centralizedConfigParameter ||
                !centralizedConfigParameter.configValue
            ) {
                return false;
            }

            if (!centralizedConfigParameter.configValue.enabled) {
                return false;
            }

            const centralizedConfigRepoId =
                centralizedConfigParameter.configValue.repository?.id;

            return centralizedConfigRepoId === event.repository?.id;
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to determine centralized config status for Kody rules listener',
                context: KodyRulesSyncListener.name,
                metadata: {
                    organizationAndTeamData: event.organizationAndTeamData,
                    repositoryId: event.repository?.id,
                },
                error,
            });

            return false;
        }
    }
}
