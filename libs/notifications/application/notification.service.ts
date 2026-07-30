import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { v4 as uuid } from 'uuid';

import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@libs/core/domain/contracts/message-broker.service.contracts';
import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';

import { EVENT_DEFAULTS } from '../domain/catalog/defaults';
import {
    NotificationEvent,
    NotificationPayloadMap,
} from '../domain/catalog/events';
import { NotificationRecipient } from '../domain/recipient';

/**
 * Standardized input for emitting a notification.
 *
 * The dispatcher used to guess recipients by introspecting payload
 * fields (`payload.users`, `payload.recipient`, `payload.email`, etc.).
 * That worked accidentally and broke whenever a new event used a new
 * shape. Recipients are now explicit on the envelope, separate from
 * payload data the email/in-app templates need.
 */
export interface EmitNotificationInput<E extends NotificationEvent> {
    event: E;
    payload: NotificationPayloadMap[E];
    organizationId: string;
    /**
     * Explicit recipients (a bare object is normalized to an array).
     * Optional for events that declare `defaultRoles` in the catalog — those
     * resolve their audience from notification config at dispatch time, so the
     * emitter doesn't choose recipients.
     */
    recipients?: NotificationRecipient | NotificationRecipient[];
    /** Optional correlation id for tracing. Generated if absent. */
    correlationId?: string;
}

/**
 * The one-liner entry point for emitting notifications.
 *
 * ```ts
 * await this.notificationService.emit({
 *     event: NotificationEvent.AUTH_FORGOT_PASSWORD,
 *     payload: { email: user.email, name: org.name, token },
 *     organizationId: org.uuid,
 *     recipients: recipientByUser(user.uuid),
 * });
 * ```
 *
 * Creates an outbox message which the OutboxRelayService picks up and
 * publishes to RabbitMQ. The worker's NotificationConsumer then handles
 * channel routing, preference resolution, and multi-channel delivery
 * for each recipient.
 */
@Injectable()
export class NotificationService {
    private readonly logger = createLogger(NotificationService.name);

    constructor(
        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outboxRepository: IOutboxMessageRepository,
        @Optional()
        private readonly metricsCollector?: MetricsCollectorService,
    ) {}

    async emit<E extends NotificationEvent>(
        input: EmitNotificationInput<E>,
    ): Promise<void> {
        const recipients = !input.recipients
            ? []
            : Array.isArray(input.recipients)
              ? input.recipients
              : [input.recipients];

        // Events that declare defaultRoles derive their audience from config
        // at dispatch time, so empty recipients is expected. For everything
        // else, no recipients means there is nothing to deliver.
        const usesConfigAudience =
            !!EVENT_DEFAULTS[input.event]?.defaultRoles;
        if (recipients.length === 0 && !usesConfigAudience) {
            this.logger.warn({
                message: `emit called with no recipients — skipping ${input.event}`,
                context: NotificationService.name,
                metadata: {
                    event: input.event,
                    organizationId: input.organizationId,
                },
            });
            return;
        }

        const correlationId = input.correlationId ?? uuid();
        const exchange = 'notification.exchange';
        const routingKey = `notification.${input.event}`;

        const messagePayload =
            this.messageBroker.transformMessageToMessageBroker({
                eventName: input.event,
                message: {
                    event: input.event,
                    payload: input.payload,
                    organizationId: input.organizationId,
                    recipients,
                    correlationId,
                },
            });

        // Notifications are not tied to a workflow_jobs row — leave jobId
        // unset so the outbox FK column stays NULL. The correlationId is
        // carried inside the payload for tracing.
        await this.outboxRepository.create({
            exchange,
            routingKey,
            payload: messagePayload as unknown as Record<string, unknown>,
        });

        const criticality =
            EVENT_DEFAULTS[input.event]?.criticality ?? 'unknown';
        this.metricsCollector?.recordCounter('notifications_emitted_total', 1, {
            event: input.event,
            criticality: String(criticality),
        });

        this.logger.log({
            message: `Notification emitted: ${input.event}`,
            context: NotificationService.name,
            metadata: {
                event: input.event,
                organizationId: input.organizationId,
                recipientCount: recipients.length,
                correlationId,
            },
        });
    }
}
