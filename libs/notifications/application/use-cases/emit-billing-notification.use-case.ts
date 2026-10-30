import { BadRequestException, Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

/** The billing callbacks that only notify the org's owners/billing managers. */
export type BillingNotificationKind =
    | 'payment-failed'
    | 'trial-expiring'
    | 'credits-purchased'
    | 'credits-low';

/**
 * Body as kodus-service-billing sends it. Read loosely on purpose: billing may
 * add fields (e.g. `autoTopUpError`) without breaking the callback, which a
 * whitelisting DTO would reject with 400.
 */
export interface BillingNotificationBody {
    organizationId?: string;
    teamId?: string;
    // payment-failed
    amount?: number;
    currency?: string;
    failureReason?: string;
    nextRetryAt?: string;
    updatePaymentUrl?: string;
    // trial-expiring
    trialEndsAt?: string;
    daysRemaining?: number;
    upgradeUrl?: string;
    // credits
    creditUsd?: number;
    balanceUsd?: number;
    thresholdUsd?: number;
    exhausted?: boolean;
}

const TOP_UP_URL = 'https://app.kodus.io/byok#kodus';

/**
 * Turns a verified billing callback into the notification for the org's
 * `role:OWNER + role:BILLING_MANAGER` audience.
 *
 * Tolerant of notification-side failures: when `emit` throws (outbox down,
 * etc.) it logs and returns, so billing gets a 200 and does not retry — the
 * billing state is already committed upstream regardless.
 */
@Injectable()
export class EmitBillingNotificationUseCase implements IUseCase {
    private readonly logger = createLogger(EmitBillingNotificationUseCase.name);

    constructor(private readonly notificationService: NotificationService) {}

    async execute(
        kind: BillingNotificationKind,
        body: BillingNotificationBody,
    ): Promise<void> {
        const organizationId = body?.organizationId;
        if (!organizationId) {
            throw new BadRequestException('Missing organizationId');
        }

        try {
            await this.emit(kind, body, organizationId);
        } catch (error) {
            this.logger.error({
                message: 'Failed to emit billing notification',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                context: EmitBillingNotificationUseCase.name,
                metadata: { organizationId, kind },
            });
        }
    }

    private emit(
        kind: BillingNotificationKind,
        body: BillingNotificationBody,
        organizationId: string,
    ): Promise<void> {
        switch (kind) {
            case 'payment-failed':
                return this.notificationService.emit({
                    event: NotificationEvent.BILLING_PAYMENT_FAILED,
                    payload: {
                        amount: body.amount ?? 0,
                        currency: body.currency ?? '',
                        failureReason:
                            body.failureReason ?? 'Unknown payment failure',
                        nextRetryAt: body.nextRetryAt,
                        updatePaymentUrl: body.updatePaymentUrl,
                    },
                    organizationId,
                });
            case 'trial-expiring':
                return this.notificationService.emit({
                    event: NotificationEvent.BILLING_TRIAL_EXPIRING,
                    payload: {
                        trialEndsAt: body.trialEndsAt ?? '',
                        daysRemaining: body.daysRemaining ?? 0,
                        upgradeUrl: body.upgradeUrl,
                    },
                    organizationId,
                });
            case 'credits-purchased':
                return this.notificationService.emit({
                    event: NotificationEvent.CREDITS_PURCHASED,
                    payload: {
                        creditUsd: Number(body.creditUsd ?? 0),
                        balanceUsd: Number(body.balanceUsd ?? 0),
                    },
                    organizationId,
                });
            case 'credits-low': {
                // One callback, two events: `exhausted` (balance ≤ 0, critical,
                // sticky banner) vs `low` (under the threshold, informational).
                // Billing fires each once per crossing, so no rate limiting.
                const balanceUsd = Number(body.balanceUsd ?? 0);
                return body.exhausted
                    ? this.notificationService.emit({
                          event: NotificationEvent.CREDITS_EXHAUSTED,
                          payload: { balanceUsd, topUpUrl: TOP_UP_URL },
                          organizationId,
                      })
                    : this.notificationService.emit({
                          event: NotificationEvent.CREDITS_LOW,
                          payload: {
                              balanceUsd,
                              thresholdUsd: Number(body.thresholdUsd ?? 0),
                              topUpUrl: TOP_UP_URL,
                          },
                          organizationId,
                      });
            }
        }
    }
}
