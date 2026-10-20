import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    IKodyRule,
    IKodyRuleAutoPause,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { NotificationService } from '@libs/notifications/application/notification.service';
import {
    KodyRuleAutoPauseEntry,
    NotificationEvent,
} from '@libs/notifications/domain/catalog/events';

import {
    COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN,
    ICockpitReviewAnalyticsService,
} from '../../domain/contracts/cockpit-review-analytics.service.contract';
import { toEntry } from './auto-pause-kody-rules.use-case';

const DIGEST_PERIOD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AutoPauseDigestRunResult {
    organizations: number;
    emailed: number;
    rules: number;
    failedOrganizations: number;
}

/**
 * Weekly email to org admins listing the Kody Rules auto-paused since the
 * last digest. A pause is listed once (`digestedAt`), also when the rule was
 * resumed in between; a rule only shows up again after a new pause. No email
 * when there is nothing new.
 */
@Injectable()
export class SendKodyRulesAutoPauseDigestUseCase {
    private readonly logger = createLogger(
        SendKodyRulesAutoPauseDigestUseCase.name,
    );

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN)
        private readonly reviewAnalytics: ICockpitReviewAnalyticsService,
        private readonly notificationService: NotificationService,
    ) {}

    async execute(now: Date = new Date()): Promise<AutoPauseDigestRunResult> {
        const result: AutoPauseDigestRunResult = {
            organizations: 0,
            emailed: 0,
            rules: 0,
            failedOrganizations: 0,
        };

        const organizationIds =
            await this.kodyRulesService.findOrganizationIdsWithRules();

        for (const organizationId of organizationIds) {
            if (!organizationId) continue;
            result.organizations++;
            try {
                const { sent } = await this.executeForOrganization(
                    organizationId,
                    now,
                );
                if (sent) {
                    result.emailed++;
                    result.rules += sent;
                }
            } catch (error) {
                result.failedOrganizations++;
                this.logger.error({
                    message:
                        'Kody Rules auto-pause digest failed for organization',
                    context: SendKodyRulesAutoPauseDigestUseCase.name,
                    error,
                    metadata: { organizationId },
                });
            }
        }

        return result;
    }

    async executeForOrganization(
        organizationId: string,
        now: Date = new Date(),
    ): Promise<{ sent: number }> {
        const doc =
            await this.kodyRulesService.findByOrganizationId(organizationId);

        const pending = (doc?.rules ?? []).flatMap((rule) => {
            const listed = pendingPauses(rule);
            return listed ? [{ rule, ...listed }] : [];
        });
        if (!doc || !pending.length) return { sent: 0 };

        const repoNames = await this.reviewAnalytics
            .getRepositoryNames(organizationId)
            .catch(() => new Map<string, string>());

        const rules: KodyRuleAutoPauseEntry[] = pending.map(
            ({ rule, latest, resumed }) => {
                const entry = toEntry(rule, latest);
                return {
                    ...entry,
                    repositoryName: entry.repositoryId
                        ? (repoNames.get(entry.repositoryId) ?? null)
                        : null,
                    resumed,
                };
            },
        );

        // Emit first, mark after: a failed emit leaves the pauses pending for
        // the next digest; a failed mark at worst lists one twice.
        await this.notificationService.emit({
            event: NotificationEvent.KODY_RULES_AUTO_PAUSE_DIGEST,
            organizationId,
            payload: {
                periodStart: new Date(
                    now.getTime() - DIGEST_PERIOD_DAYS * DAY_MS,
                ).toISOString(),
                periodEnd: now.toISOString(),
                rules,
            },
        });

        for (const { rule, pausedAts } of pending) {
            try {
                const marked =
                    await this.kodyRulesService.markAutoPausesDigested(
                        organizationId,
                        rule.uuid!,
                        pausedAts,
                        now,
                    );
                if (!marked) {
                    // Paused again or deleted since the read: nothing to mark.
                    this.logger.warn({
                        message:
                            'Auto-paused Kody Rule changed before it was marked as digested',
                        context: SendKodyRulesAutoPauseDigestUseCase.name,
                        metadata: { organizationId, ruleId: rule.uuid },
                    });
                }
            } catch (error) {
                this.logger.error({
                    message: 'Failed to mark auto-paused Kody Rule as digested',
                    context: SendKodyRulesAutoPauseDigestUseCase.name,
                    error,
                    metadata: { organizationId, ruleId: rule.uuid },
                });
            }
        }

        this.logger.log({
            message: 'Kody Rules auto-pause digest sent',
            context: SendKodyRulesAutoPauseDigestUseCase.name,
            metadata: {
                organizationId,
                ruleIds: rules.map((entry) => entry.ruleId),
            },
        });

        return { sent: rules.length };
    }
}

/**
 * The undigested pauses of a rule: the one to list (the latest) and every
 * pause to mark, so a rule paused twice in a week is listed once.
 */
function pendingPauses(rule: Partial<IKodyRule>):
    | {
          latest: IKodyRuleAutoPause;
          resumed: boolean;
          pausedAts: Date[];
      }
    | undefined {
    if (!rule.uuid || rule.status === KodyRulesStatus.DELETED) return;

    const patch: Partial<
        Record<'autoPause' | 'lastAutoPause', IKodyRuleAutoPause>
    > = {};
    if (rule.autoPause && !rule.autoPause.digestedAt) {
        patch.autoPause = rule.autoPause;
    }
    if (rule.lastAutoPause && !rule.lastAutoPause.digestedAt) {
        patch.lastAutoPause = rule.lastAutoPause;
    }

    const latest = patch.autoPause ?? patch.lastAutoPause;
    if (!latest) return;

    return {
        latest,
        resumed: !rule.autoPause,
        pausedAts: [patch.autoPause, patch.lastAutoPause]
            .filter((pause): pause is IKodyRuleAutoPause => !!pause)
            .map((pause) => pause.pausedAt),
    };
}
