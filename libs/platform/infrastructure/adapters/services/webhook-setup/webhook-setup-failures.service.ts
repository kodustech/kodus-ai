import { Inject, Injectable } from '@nestjs/common';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    WebhookSetupFailureKind,
    WebhookSetupResult,
} from './webhook-setup';

export interface StoredWebhookFailure {
    reason: string;
    at: string;
    kind?: WebhookSetupFailureKind;
}

interface StoredWebhookFailures {
    startedAt?: string;
    recordedAt?: string;
    failures?: Record<string, StoredWebhookFailure>;
}

const PENDING_AFTER_RATE_LIMIT =
    'Waiting: the provider rate-limited the last sync before this repository was reached. It will be retried on the next sync.';

export interface RecordWebhookSetupOutcomeParams {
    organizationAndTeamData: OrganizationAndTeamData;
    integrationId: string;
    /** When the run began observing; orders overlapping runs. */
    startedAt: string;
    result: WebhookSetupResult;
}

const logger = createLogger('WebhookSetupFailures');

/**
 * Merges one webhook setup run into the team's `WEBHOOK_CREATION_FAILURES`
 * record. Never throws: losing the record must not fail the caller.
 */
export async function recordWebhookSetupOutcome(
    integrationConfigService: IIntegrationConfigService,
    params: RecordWebhookSetupOutcomeParams,
): Promise<void> {
    const { organizationAndTeamData, integrationId, startedAt, result } =
        params;

    try {
        const stored =
            (await integrationConfigService.findIntegrationConfigFormatted<StoredWebhookFailures>(
                IntegrationConfigKey.WEBHOOK_CREATION_FAILURES,
                organizationAndTeamData,
            )) ?? {};

        const failures: Record<string, StoredWebhookFailure> = {
            ...(stored.failures ?? {}),
        };

        const isNewer = (id: string) =>
            !failures[id] || failures[id].at <= startedAt;

        for (const id of result.configured) {
            if (isNewer(id)) {
                delete failures[id];
            }
        }

        for (const [id, failure] of Object.entries(result.failed)) {
            if (isNewer(id)) {
                failures[id] = {
                    reason: failure.reason,
                    kind: failure.kind,
                    at: startedAt,
                };
            }
        }

        for (const id of result.notAttempted) {
            if (!failures[id]) {
                failures[id] = result.deferred
                    ? {
                          reason: result.deferred.reason,
                          kind: 'deferred',
                          at: startedAt,
                      }
                    : {
                          reason: PENDING_AFTER_RATE_LIMIT,
                          kind: 'rate_limited',
                          at: startedAt,
                      };
            }
        }

        const selection =
            (await integrationConfigService.findIntegrationConfigFormatted<
                Array<{ id: string | number }>
            >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData)) ??
            [];
        const selectedIds = new Set(
            (Array.isArray(selection) ? selection : []).map((repo) =>
                String(repo?.id),
            ),
        );

        for (const id of Object.keys(failures)) {
            if (!selectedIds.has(id)) {
                delete failures[id];
            }
        }

        await integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.WEBHOOK_CREATION_FAILURES,
            {
                ...stored,
                recordedAt: new Date().toISOString(),
                failures,
            },
            integrationId,
            organizationAndTeamData,
        );

        logger.log({
            message: 'Recorded webhook setup outcome',
            context: 'WebhookSetupFailures',
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                configured: result.configured.length,
                failed: Object.keys(result.failed).length,
                notAttempted: result.notAttempted.length,
                pending: Object.keys(failures).length,
            },
        });
    } catch (error) {
        logger.error({
            message: 'Error recording webhook setup outcome',
            context: 'WebhookSetupFailures',
            error,
            metadata: {
                organizationId: organizationAndTeamData?.organizationId,
                teamId: organizationAndTeamData?.teamId,
            },
        });
    }
}

/**
 * The per-repository webhook failure record (`WEBHOOK_CREATION_FAILURES`),
 * shared by every provider. It doubles as the pending-work list: a repository
 * listed here still needs its webhook and is retried on every sync.
 *
 * Entries are merged rather than replaced, so a sync that touched a few
 * repositories leaves the others' entries alone. An entry is only replaced by
 * a run that started after the one that wrote it, so two overlapping runs
 * cannot resurrect or erase each other's observation.
 */
@Injectable()
export class WebhookSetupFailuresService {
    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    async recordOutcome(
        params: RecordWebhookSetupOutcomeParams,
    ): Promise<void> {
        await recordWebhookSetupOutcome(this.integrationConfigService, params);
    }

    async pendingRepositoryIds(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string[]> {
        const stored =
            await this.integrationConfigService.findIntegrationConfigFormatted<StoredWebhookFailures>(
                IntegrationConfigKey.WEBHOOK_CREATION_FAILURES,
                organizationAndTeamData,
            );

        return Object.keys(stored?.failures ?? {});
    }
}
