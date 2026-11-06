import { Inject, Injectable } from '@nestjs/common';

import { UpdateCodeReviewParameterRepositoriesUseCase } from '@libs/code-review/application/use-cases/configuration/update-code-review-parameter-repositories-use-case';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { RepositoryConnectionService } from '@libs/platform/application/services/repository-sync/repository-connection.service';
import {
    credentialFingerprint,
    filterDiscoveredRepositories,
    RepositorySelectionConfig,
    RepositorySyncState,
    RepositorySyncTrigger,
} from '@libs/platform/application/services/repository-sync/repository-sync.types';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { WebhookSetupResult } from '@libs/platform/domain/platformIntegrations/types/codeManagement/webhook-setup.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { recordWebhookSetupOutcome } from '@libs/platform/infrastructure/adapters/services/webhook-setup/webhook-setup-failures.service';

/** A team in "review all repositories" mode, as the sync sees it. */
interface SyncTarget {
    organizationAndTeamData: OrganizationAndTeamData;
    integrationId: string;
    platform: PlatformType;
    selection: RepositorySelectionConfig;
}

type TeamOutcome = { rateLimited: boolean };

const LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * Keeps the repository selection of every team in "review all repositories"
 * mode equal to what its credential can see, minus archived repositories
 * (and forks and mirrors unless the team includes them).
 *
 * Append-only: a repository is never removed, so a provider hiccup can never
 * shrink a selection. Discovery runs once per credential per run, under a
 * lock per credential, and the per-repository work (webhooks, AST builds,
 * history backfill) is bounded per run so a large first enable neither
 * exhausts the provider's rate limit nor floods the shared AST queue.
 */
@Injectable()
export class SyncAllRepositoriesUseCase {
    /** Repositories per webhook batch; progress is written after each. */
    static readonly WEBHOOK_BATCH_SIZE = 25;
    /** Repositories whose history backfill starts per team per run. */
    static readonly BACKFILL_PER_RUN = 25;
    /** AST builds a team may have queued or running at once. */
    static readonly AST_BUILDS_PER_TEAM = 5;

    private readonly logger = createLogger(SyncAllRepositoriesUseCase.name);

    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        private readonly codeManagementService: CodeManagementService,
        private readonly updateCodeReviewParameterRepositoriesUseCase: UpdateCodeReviewParameterRepositoriesUseCase,
        private readonly repositoryConnectionService: RepositoryConnectionService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    /** Every team in "all" mode, grouped by credential. */
    async runScheduledSync(): Promise<{ groups: number; teams: number }> {
        const targets = await this.findTargets();
        const groups = await this.groupByCredential(targets);

        for (const [fingerprint, group] of groups) {
            await this.syncGroup(fingerprint, group, 'cron');
        }

        this.logger.log({
            message: 'Scheduled repository sync finished',
            context: SyncAllRepositoriesUseCase.name,
            metadata: { groups: groups.size, teams: targets.length },
        });

        return { groups: groups.size, teams: targets.length };
    }

    async syncTeam(
        organizationAndTeamData: OrganizationAndTeamData,
        trigger: RepositorySyncTrigger,
    ): Promise<void> {
        const targets = (await this.findTargets()).filter(
            (target) =>
                target.organizationAndTeamData.teamId ===
                organizationAndTeamData.teamId,
        );

        if (!targets.length) {
            return;
        }

        const groups = await this.groupByCredential(targets);
        for (const [fingerprint, group] of groups) {
            await this.syncGroup(fingerprint, group, trigger);
        }
    }

    /**
     * For a GitHub App event announcing a new repository: syncs the teams in
     * "all" mode whose integration uses that installation.
     */
    async syncInstallation(installationId: string): Promise<void> {
        const targets: SyncTarget[] = [];

        for (const target of await this.findTargets()) {
            if (target.platform !== PlatformType.GITHUB) {
                continue;
            }
            const authDetails = await this.integrationService
                .getPlatformAuthDetails<{ installationId?: string | number }>(
                    target.organizationAndTeamData,
                    target.platform,
                )
                .catch(() => null);
            if (String(authDetails?.installationId ?? '') === installationId) {
                targets.push(target);
            }
        }

        this.logger.log({
            message: 'GitHub App reported a new repository',
            context: SyncAllRepositoriesUseCase.name,
            metadata: {
                installationId,
                teams: targets.map((t) => t.organizationAndTeamData.teamId),
            },
        });

        const groups = await this.groupByCredential(targets);
        for (const [fingerprint, group] of groups) {
            await this.syncGroup(fingerprint, group, 'provider_event');
        }
    }

    /**
     * How many repositories enabling "all" would add, without writing.
     */
    async preview(
        organizationAndTeamData: OrganizationAndTeamData,
        options: { includeForksAndMirrors?: boolean },
    ): Promise<{
        visible: number;
        eligible: number;
        alreadySelected: number;
        toAdd: number;
        skipped: { archived: number; forksAndMirrors: number };
    }> {
        const visible = await this.codeManagementService.getRepositories({
            organizationAndTeamData,
        });
        const { eligible, skipped } = filterDiscoveredRepositories(
            visible,
            options,
        );
        const selectedIds = await this.selectedIds(organizationAndTeamData);
        const alreadySelected = eligible.filter((repo) =>
            selectedIds.has(String(repo.id)),
        ).length;

        return {
            visible: visible.length,
            eligible: eligible.length,
            alreadySelected,
            toAdd: eligible.length - alreadySelected,
            skipped,
        };
    }

    private async findTargets(): Promise<SyncTarget[]> {
        const rows = await this.integrationConfigService.find({
            configKey: IntegrationConfigKey.REPOSITORY_SELECTION,
        });

        // `find` loads the organization with the integration, not the team.
        const organizationOf = (row: (typeof rows)[number]) =>
            row.integration?.organization?.uuid ?? row.team?.organization?.uuid;

        return (rows ?? [])
            .filter(
                (row) =>
                    (row.configValue as RepositorySelectionConfig)?.mode ===
                        'all' &&
                    row.team?.status === STATUS.ACTIVE &&
                    row.integration?.status !== false &&
                    organizationOf(row),
            )
            .map((row) => ({
                organizationAndTeamData: {
                    organizationId: organizationOf(row),
                    teamId: row.team.uuid,
                },
                integrationId: row.integration?.uuid,
                platform: row.integration?.platform as PlatformType,
                selection: row.configValue as RepositorySelectionConfig,
            }));
    }

    private async groupByCredential(
        targets: SyncTarget[],
    ): Promise<Map<string, SyncTarget[]>> {
        const groups = new Map<string, SyncTarget[]>();

        for (const target of targets) {
            let fingerprint: string | null = null;
            try {
                fingerprint = credentialFingerprint(
                    target.platform,
                    await this.integrationService.getPlatformAuthDetails(
                        target.organizationAndTeamData,
                        target.platform,
                    ),
                );
            } catch (error) {
                this.logger.warn({
                    message:
                        'Could not identify the credential; syncing the team on its own',
                    context: SyncAllRepositoriesUseCase.name,
                    error,
                    metadata: target.organizationAndTeamData,
                });
            }

            const groupKey =
                fingerprint ?? `team:${target.organizationAndTeamData.teamId}`;
            groups.set(groupKey, [...(groups.get(groupKey) ?? []), target]);
        }

        return groups;
    }

    private async syncGroup(
        fingerprint: string,
        group: SyncTarget[],
        trigger: RepositorySyncTrigger,
    ): Promise<void> {
        const lockKey = `REPOSITORY_SYNC:${fingerprint}`;
        const lock = await this.distributedLockService
            .acquire(lockKey, { ttl: LOCK_TTL_MS })
            .catch((error) => {
                this.logger.error({
                    message: 'Error acquiring the repository sync lock',
                    context: SyncAllRepositoriesUseCase.name,
                    error,
                    metadata: { teams: group.map((t) => t.organizationAndTeamData) },
                });
                return null;
            });

        if (!lock) {
            this.logger.log({
                message:
                    'Repository sync skipped: another run holds this credential',
                context: SyncAllRepositoriesUseCase.name,
                metadata: {
                    trigger,
                    teams: group.map((t) => t.organizationAndTeamData.teamId),
                },
            });
            return;
        }

        try {
            const startedAt = new Date().toISOString();
            let listing: Repositories[];

            try {
                listing = await this.codeManagementService.getRepositories(
                    { organizationAndTeamData: group[0].organizationAndTeamData },
                    group[0].platform,
                );
            } catch (error) {
                const message = describeError(error);
                this.logger.error({
                    message:
                        'Repository discovery failed; nothing was added or changed',
                    context: SyncAllRepositoriesUseCase.name,
                    error,
                    metadata: {
                        trigger,
                        teams: group.map((t) => t.organizationAndTeamData),
                    },
                });
                for (const target of group) {
                    await this.writeState(target, {
                        status: 'failed',
                        trigger,
                        startedAt,
                        finishedAt: new Date().toISOString(),
                        error: `Could not list the repositories: ${message}`,
                    });
                }
                return;
            }

            for (let index = 0; index < group.length; index += 1) {
                const outcome = await this.syncTeamWithListing(
                    group[index],
                    listing,
                    trigger,
                );

                if (outcome.rateLimited) {
                    for (const waiting of group.slice(index + 1)) {
                        await this.writeState(waiting, {
                            status: 'rate_limited',
                            trigger,
                            startedAt,
                            finishedAt: new Date().toISOString(),
                            error: 'The provider rate-limited this credential; the sync continues on its next run.',
                        });
                    }
                    break;
                }
            }
        } finally {
            await lock.release().catch(() => undefined);
        }
    }

    private async syncTeamWithListing(
        target: SyncTarget,
        listing: Repositories[],
        trigger: RepositorySyncTrigger,
    ): Promise<TeamOutcome> {
        const { organizationAndTeamData } = target;
        const startedAt = new Date().toISOString();
        const previous = await this.readState(organizationAndTeamData);

        try {
            const { eligible, skipped } = filterDiscoveredRepositories(
                listing,
                target.selection,
            );

            const current =
                (await this.integrationConfigService.findIntegrationConfigFormatted<
                    Repositories[]
                >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData)) ??
                [];
            const currentIds = new Set(current.map((repo) => String(repo.id)));
            const added = eligible
                .filter((repo) => !currentIds.has(String(repo.id)))
                .map((repo) => ({ ...repo, selected: true }));

            const pendingWebhookIds = new Set(
                Object.keys(
                    (
                        await this.integrationConfigService.findIntegrationConfigFormatted<{
                            failures?: Record<string, unknown>;
                        }>(
                            IntegrationConfigKey.WEBHOOK_CREATION_FAILURES,
                            organizationAndTeamData,
                        )
                    )?.failures ?? {},
                ),
            );
            const pendingWebhookRepos = current.filter((repo) =>
                pendingWebhookIds.has(String(repo.id)),
            );
            const webhookTargets = [...added, ...pendingWebhookRepos];

            const state: RepositorySyncState = {
                status: 'running',
                trigger,
                startedAt,
                lastSuccessAt: previous?.lastSuccessAt,
                visible: listing.length,
                skipped,
                added: added.length,
                total: webhookTargets.length,
                done: 0,
                pendingAstRepositoryIds: previous?.pendingAstRepositoryIds ?? [],
                pendingBackfillRepositoryIds:
                    previous?.pendingBackfillRepositoryIds ?? [],
            };
            await this.writeState(target, state);

            if (added.length) {
                await this.codeManagementService.createOrUpdateIntegrationConfig(
                    {
                        configKey: IntegrationConfigKey.REPOSITORIES,
                        configValue: added,
                        type: 'append',
                        // Webhooks are set up below for the new repositories
                        // only; the provider's own pass would walk them all.
                        deferWebhooks: true,
                        organizationAndTeamData,
                    },
                    target.platform,
                );

                await this.updateCodeReviewParameterRepositoriesUseCase.execute({
                    organizationAndTeamData,
                    actor: {
                        source: 'sync',
                        organizationId: organizationAndTeamData.organizationId,
                    },
                });

                await this.repositoryConnectionService.registerRepositoryRecords(
                    {
                        organizationAndTeamData,
                        platform: target.platform,
                        repositories: added,
                    },
                );

                const addedIds = added.map((repo) => String(repo.id));
                state.pendingAstRepositoryIds = unique([
                    ...state.pendingAstRepositoryIds,
                    ...addedIds,
                ]);
                state.pendingBackfillRepositoryIds = unique([
                    ...state.pendingBackfillRepositoryIds,
                    ...addedIds,
                ]);
            }

            const rateLimited = await this.setUpWebhooks(
                target,
                webhookTargets,
                state,
            );

            const known = new Map(
                [...current, ...added].map((repo) => [String(repo.id), repo]),
            );
            this.startBackfillBatch(target, state, known);
            await this.drainAstBuilds(target, state, known);

            state.status = rateLimited ? 'rate_limited' : 'done';
            state.finishedAt = new Date().toISOString();
            if (!rateLimited) {
                state.lastSuccessAt = state.finishedAt;
                delete state.error;
            } else {
                state.error =
                    'The provider rate-limited this credential; the sync continues on its next run.';
            }
            await this.writeState(target, state);

            this.logger.log({
                message: 'Repository sync finished for team',
                context: SyncAllRepositoriesUseCase.name,
                metadata: {
                    ...organizationAndTeamData,
                    trigger,
                    platform: target.platform,
                    visible: listing.length,
                    eligible: eligible.length,
                    added: added.length,
                    skipped,
                    webhookTargets: webhookTargets.length,
                    rateLimited,
                    pendingAst: state.pendingAstRepositoryIds.length,
                    pendingBackfill: state.pendingBackfillRepositoryIds.length,
                },
            });

            return { rateLimited };
        } catch (error) {
            this.logger.error({
                message: 'Repository sync failed for team',
                context: SyncAllRepositoriesUseCase.name,
                error,
                metadata: { ...organizationAndTeamData, trigger },
            });
            await this.writeState(target, {
                ...(previous ?? {}),
                status: 'failed',
                trigger,
                startedAt,
                finishedAt: new Date().toISOString(),
                error: describeError(error),
            });
            return { rateLimited: false };
        }
    }

    /** True when the provider rate-limited the run. */
    private async setUpWebhooks(
        target: SyncTarget,
        repositories: Repositories[],
        state: RepositorySyncState,
    ): Promise<boolean> {
        const { organizationAndTeamData, integrationId } = target;
        const batchSize = SyncAllRepositoriesUseCase.WEBHOOK_BATCH_SIZE;

        for (let offset = 0; offset < repositories.length; offset += batchSize) {
            const batch = repositories.slice(offset, offset + batchSize);
            const startedAt = new Date().toISOString();
            let result: WebhookSetupResult =
                await this.codeManagementService.ensureRepositoryWebhooks(
                    { organizationAndTeamData, repositories: batch },
                    target.platform,
                );

            const rateLimited = Boolean(result.rateLimited);
            if (rateLimited) {
                result = {
                    ...result,
                    notAttempted: [
                        ...result.notAttempted,
                        ...repositories
                            .slice(offset + batchSize)
                            .map((repo) => String(repo.id)),
                    ],
                };
            }

            if (!result.managedByApp && integrationId) {
                await recordWebhookSetupOutcome(this.integrationConfigService, {
                    organizationAndTeamData,
                    integrationId,
                    startedAt,
                    result,
                });
            }

            state.done = Math.min(offset + batch.length, repositories.length);
            if (rateLimited) {
                return true;
            }
            await this.writeState(target, state);
        }

        return false;
    }

    private startBackfillBatch(
        target: SyncTarget,
        state: RepositorySyncState,
        known: Map<string, Repositories>,
    ): void {
        const pending = state.pendingBackfillRepositoryIds ?? [];
        if (!pending.length) {
            return;
        }

        const batchIds = pending.slice(0, SyncAllRepositoriesUseCase.BACKFILL_PER_RUN);
        const batch = batchIds
            .map((id) => known.get(id))
            .filter((repo): repo is Repositories => Boolean(repo));

        const started = this.repositoryConnectionService.startHistoricalBackfill(
            target.organizationAndTeamData,
            batch,
        );

        if (started || !batch.length) {
            state.pendingBackfillRepositoryIds = pending.slice(batchIds.length);
        }
    }

    private async drainAstBuilds(
        target: SyncTarget,
        state: RepositorySyncState,
        known: Map<string, Repositories>,
    ): Promise<void> {
        const pending = state.pendingAstRepositoryIds ?? [];
        if (!pending.length) {
            return;
        }

        const inFlight =
            await this.repositoryConnectionService.countInFlightAstBuilds(
                target.organizationAndTeamData,
            );
        const slots = Math.max(
            0,
            SyncAllRepositoriesUseCase.AST_BUILDS_PER_TEAM - inFlight,
        );
        const remaining = [...pending];
        let enqueued = 0;

        while (enqueued < slots && remaining.length) {
            const id = remaining.shift();
            const repository = known.get(id);
            try {
                const record =
                    await this.repositoryConnectionService.findRepositoryRecord(
                        target.platform,
                        id,
                    );
                if (
                    record &&
                    (await this.repositoryConnectionService.enqueueAstBuild({
                        organizationAndTeamData: target.organizationAndTeamData,
                        record,
                        cloneUrl: repository?.http_url,
                    }))
                ) {
                    enqueued += 1;
                }
            } catch (error) {
                this.logger.error({
                    message: 'Failed to enqueue an AST build from the sync',
                    context: SyncAllRepositoriesUseCase.name,
                    error,
                    metadata: {
                        ...target.organizationAndTeamData,
                        repositoryId: id,
                    },
                });
            }
        }

        state.pendingAstRepositoryIds = remaining;
    }

    private async selectedIds(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<Set<string>> {
        const current =
            (await this.integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData)) ?? [];
        return new Set(current.map((repo) => String(repo.id)));
    }

    private async readState(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<RepositorySyncState | null> {
        try {
            return await this.integrationConfigService.findIntegrationConfigFormatted<RepositorySyncState>(
                IntegrationConfigKey.REPOSITORY_SYNC_STATE,
                organizationAndTeamData,
            );
        } catch {
            return null;
        }
    }

    private async writeState(
        target: SyncTarget,
        state: RepositorySyncState,
    ): Promise<void> {
        try {
            await this.integrationConfigService.createOrUpdateConfig(
                IntegrationConfigKey.REPOSITORY_SYNC_STATE,
                state,
                target.integrationId,
                target.organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error writing the repository sync state',
                context: SyncAllRepositoriesUseCase.name,
                error,
                metadata: target.organizationAndTeamData,
            });
        }
    }
}

function unique(ids: string[]): string[] {
    return [...new Set(ids)];
}

function describeError(error: unknown): string {
    const err = error as { message?: string; response?: { message?: string } };
    return err?.response?.message || err?.message || String(error);
}
