import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

import { decideSpendAlerts } from '@libs/analytics/domain/spend-limit/spend-alert-decision';

import { SpendLimitConfigService } from './spend-limit-config.service';

/**
 * Evaluates one organization's month-to-date BYOK spend and emits threshold
 * alerts (50/75/90/100%) plus the one-time over-limit final notice, each at
 * most once per period. Notification-only — it never blocks a review.
 *
 * Alerts are emitted before alert state is persisted, so a failed emit simply
 * retries next tick rather than being silently marked as sent.
 */
@Injectable()
export class SpendLimitAlertService {
    private readonly logger = createLogger(SpendLimitAlertService.name);

    constructor(
        private readonly configService: SpendLimitConfigService,
        private readonly notifications: NotificationService,
    ) {}

    async runForOrganization(
        organizationAndTeamData: OrganizationAndTeamData,
        now: Date = new Date(),
    ): Promise<void> {
        const loaded = await this.configService.loadAndEvaluate(
            organizationAndTeamData,
            now,
        );
        if (!loaded) return;

        const { config, evaluation } = loaded;
        const { periodKey } = evaluation;
        const { organizationId } = organizationAndTeamData;

        const decision = decideSpendAlerts(evaluation, {
            thresholdsSent: config.thresholdsSent?.[periodKey],
            finalNoticeSent: config.finalNoticeSent?.[periodKey],
        });

        // Fan the alerts out together: one flaky emit shouldn't stop the
        // others (they're independent outbox writes, order doesn't matter).
        const emits = decision.thresholdsToAlert.map((percentage) =>
            this.notifications.emit({
                event: NotificationEvent.SPEND_LIMIT_THRESHOLD_REACHED,
                organizationId,
                payload: {
                    percentage,
                    monthlyLimitUsd: config.monthlyLimitUsd,
                    spentUsd: evaluation.spentUsd,
                    periodKey,
                },
            }),
        );

        if (decision.sendFinalNotice) {
            emits.push(
                this.notifications.emit({
                    event: NotificationEvent.SPEND_LIMIT_EXCEEDED_FINAL,
                    organizationId,
                    payload: {
                        monthlyLimitUsd: config.monthlyLimitUsd,
                        spentUsd: evaluation.spentUsd,
                        periodKey,
                    },
                }),
            );
        }

        await Promise.allSettled(emits);

        if (decision.changed) {
            await this.configService.saveConfig(organizationAndTeamData, {
                ...config,
                thresholdsSent: {
                    ...config.thresholdsSent,
                    [periodKey]: decision.nextThresholdsSent,
                },
                finalNoticeSent: {
                    ...config.finalNoticeSent,
                    [periodKey]: decision.nextFinalNoticeSent,
                },
            });
        }
    }
}
