import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';

import { NotificationEvent } from '../domain/catalog/events';
import { EVENT_DEFAULTS, ROLE_WILDCARD } from '../domain/catalog/defaults';
import { IRoutingRule } from '../domain/interfaces/routing-rule.interface';
import {
    Criticality,
    DeliveryStatus,
    NotificationChannel,
    ACTIVE_CHANNELS,
} from '../domain/enums';
import {
    IChannelAdapter,
    NotificationDeliveryContext,
    CHANNEL_ADAPTERS_TOKEN,
} from '../domain/contracts/channel-adapter.contract';
import {
    INotificationDeliveryRepository,
    NOTIFICATION_DELIVERY_REPOSITORY_TOKEN,
} from '../domain/contracts/notification-delivery.repository.contract';
import { INotificationDelivery } from '../domain/interfaces/notification-delivery.interface';
import {
    IRoutingRuleRepository,
    ROUTING_RULE_REPOSITORY_TOKEN,
} from '../domain/contracts/routing-rule.repository.contract';
import { NotificationRecipient } from '../domain/recipient';
import { IN_APP_TEMPLATE_REGISTRY } from '../infrastructure/adapters/channels/in-app-template.registry';
import { NotificationSseService } from './notification-sse.service';
import { decideRetry } from './retry-policy';

export interface NotificationMessage {
    event: NotificationEvent;
    payload: Record<string, unknown>;
    organizationId: string;
    /** Explicit recipients chosen by the emitter. Always an array on the wire. */
    recipients: NotificationRecipient[];
    correlationId: string;
}

interface ResolvedRecipient {
    userId: string;
    email: string;
    role: string;
    /**
     * Optional per-recipient channel restriction copied from the
     * originating NotificationRecipient. When set, dispatch only
     * targets the intersection of this list with the event's resolved
     * channels — used by events like org.member_removed where one
     * recipient gets email and another gets in-app.
     */
    channels?: NotificationChannel[];
    /**
     * True for the explicit envelope recipients the emitter chose (the PR
     * author, the removed user, the sync initiator). They are always
     * delivered, on their own/default channels, regardless of whether their
     * role is one of the event's defaultRoles — so a directly-involved
     * contributor is never gated off. Config-driven audience members
     * (from defaultRoles) leave this unset.
     */
    directed?: boolean;
}

/**
 * Worker-side fanout logic.
 *
 * 1. Resolve target users from payload context
 * 2. For each user: resolve routing rule → determine channels
 * 3. For each channel: create delivery record → call adapter → update status
 */
@Injectable()
export class NotificationDispatcherService {
    private readonly logger = createLogger(
        NotificationDispatcherService.name,
    );
    private readonly adapterMap: Map<NotificationChannel, IChannelAdapter>;

    constructor(
        @Inject(CHANNEL_ADAPTERS_TOKEN)
        private readonly adapters: IChannelAdapter[],
        @Inject(NOTIFICATION_DELIVERY_REPOSITORY_TOKEN)
        private readonly deliveryRepo: INotificationDeliveryRepository,
        @Inject(ROUTING_RULE_REPOSITORY_TOKEN)
        private readonly routingRuleRepo: IRoutingRuleRepository,
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
        private readonly sseService: NotificationSseService,
        @Optional()
        private readonly metricsCollector?: MetricsCollectorService,
    ) {
        this.adapterMap = new Map(
            adapters
                .filter((a) => ACTIVE_CHANNELS.has(a.channel))
                .map((a) => [a.channel, a]),
        );
    }

    async dispatch(message: NotificationMessage): Promise<void> {
        const { event, payload, organizationId, correlationId } = message;
        const defaults = EVENT_DEFAULTS[event];

        if (!defaults) {
            this.logger.warn({
                message: `Unknown notification event: ${event}`,
                context: NotificationDispatcherService.name,
                metadata: { event, correlationId },
            });
            return;
        }

        // Preload the org's routing rules once so per-recipient channel
        // resolution is in-memory (no N queries during fanout). Indexed by
        // `${event}:${role}` so each recipient's lookup is O(1) rather than an
        // O(rules) scan — the fanout loop below runs once per recipient.
        const rules =
            await this.routingRuleRepo.findByOrganization(organizationId);
        const ruleByKey = new Map<string, IRoutingRule>();
        for (const r of rules) {
            ruleByKey.set(`${r.event}:${r.role}`, r);
        }

        // Two independent recipient sources, unioned so an event can reach
        // both at once (the "mixed" events):
        //
        //  - directed: the explicit envelope recipients the emitter chose (PR
        //    author, removed user, …). Always delivered, bypassing role gating.
        //  - audience: events declaring `defaultRoles` also fan out to every
        //    org member, gated per role by routing config (default roles on,
        //    admins can opt others in).
        //
        // A user present in both keeps the directed entry (listed first, so
        // dedup wins) and is never gated off for not being a default role.
        const directed = message.recipients?.length
            ? (await this.resolveRecipients(message, organizationId)).map(
                  (r) => ({ ...r, directed: true }),
              )
            : [];
        const audience = defaults.defaultRoles
            ? await this.resolveAllOrgMembers(organizationId)
            : [];
        const recipients = this.dedupeByUser([...directed, ...audience]);

        // Per-recipient try/catch so a thrown error (DB outage, adapter
        // bug) for one recipient does not abort the loop and bubble up
        // to the worker. If it did, the message would be NACK'd and
        // every recipient already processed before the failure would
        // receive a duplicate notification on retry.
        for (const recipient of recipients) {
            try {
                await this.dispatchToRecipient(
                    recipient,
                    event,
                    defaults,
                    payload,
                    organizationId,
                    correlationId,
                    ruleByKey,
                );
            } catch (error) {
                this.logger.error({
                    message:
                        'Unhandled error dispatching to recipient — continuing fanout',
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    context: NotificationDispatcherService.name,
                    metadata: {
                        event,
                        recipientUserId: recipient.userId,
                        recipientEmail: recipient.email,
                        organizationId,
                        correlationId,
                    },
                });
            }
        }
    }

    /**
     * Dedup a unioned recipient list by user (email-only fallbacks keyed by
     * address). First occurrence wins, so directed recipients — which are
     * listed before the config audience — take precedence over the same user
     * resolved as an audience member.
     */
    private dedupeByUser(
        recipients: ResolvedRecipient[],
    ): ResolvedRecipient[] {
        const byKey = new Map<string, ResolvedRecipient>();
        for (const r of recipients) {
            const key = r.userId ? r.userId : `EMAIL:${r.email}`;
            if (!byKey.has(key)) byKey.set(key, r);
        }
        return [...byKey.values()];
    }

    private async dispatchToRecipient(
        recipient: ResolvedRecipient,
        event: NotificationEvent,
        defaults: (typeof EVENT_DEFAULTS)[NotificationEvent],
        payload: Record<string, unknown>,
        organizationId: string,
        correlationId: string,
        ruleByKey: Map<string, IRoutingRule>,
    ): Promise<void> {
        // Directed recipients (the directly-involved person — PR author, sync
        // initiator, removed user) are always reached: they bypass role-based
        // routing config and resolve to the event's catalog defaults, narrowed
        // only by any per-recipient channel override below. This is what keeps
        // a non-default-role directed recipient from being swallowed by an
        // off ('{}') wildcard baseline. Audience members go through the rules.
        let enabledChannels = recipient.directed
            ? [...defaults.defaultChannels].filter((ch) =>
                  ACTIVE_CHANNELS.has(ch),
              )
            : this.resolveEnabledChannels(
                  ruleByKey,
                  event,
                  recipient.role,
                  defaults,
              );

        // Per-recipient channel override: when the originating
        // NotificationRecipient declared `channels`, intersect with the
        // event-resolved channels. Used by events that need a
        // recipient-specific channel mix (e.g. org.member_removed sends
        // email to the removed user and in-app to the surviving owners).
        if (recipient.channels?.length) {
            const allowed = new Set(recipient.channels);
            enabledChannels = enabledChannels.filter((ch) => allowed.has(ch));
        }

        const template = this.resolveInAppTemplate(event, payload);
        const title = template.title;
        const body = template.body;
        const ctaUrl =
            template.ctaUrl ?? (payload.ctaUrl as string) ?? undefined;

        for (const channel of enabledChannels) {
            const adapter = this.adapterMap.get(channel);
            if (!adapter) continue;

            // The in-app channel writes a `user_notifications` row keyed
            // on a real user uuid. When the recipient is an email-only
            // fallback (e.g. signup confirmation to a not-yet-registered
            // address), there is no user to attach to — skip in-app and
            // let the email channel handle it.
            if (
                channel === NotificationChannel.IN_APP &&
                !recipient.userId
            ) {
                this.logger.warn({
                    message:
                        'Skipping in-app delivery: recipient has no user uuid',
                    context: NotificationDispatcherService.name,
                    metadata: {
                        event,
                        recipientEmail: recipient.email,
                        organizationId,
                        correlationId,
                    },
                });
                this.metricsCollector?.recordCounter(
                    'notification_deliveries_total',
                    1,
                    { channel, status: 'skipped' },
                );
                continue;
            }

            // Create delivery record (pending). `recipientRole` is
            // captured as a snapshot so the retry worker can rebuild the
            // adapter context without re-querying the user.
            //
            // The create call sits inside the same try/catch as the
            // adapter call so a transient DB failure mid-fanout doesn't
            // throw past the channel loop. If it did, the outer
            // recipient loop would abort, the worker would NACK and
            // retry, and every recipient processed before the failure
            // would get a duplicate notification.
            let delivery: INotificationDelivery;
            try {
                delivery = await this.deliveryRepo.create({
                    organization: { uuid: organizationId },
                    event,
                    criticality: defaults.criticality,
                    channel,
                    title,
                    body,
                    ctaUrl,
                    category: defaults.category,
                    recipientEmail:
                        channel === NotificationChannel.EMAIL
                            ? recipient.email
                            : undefined,
                    recipientRole: recipient.role,
                    recipientUser: recipient.userId
                        ? { uuid: recipient.userId }
                        : undefined,
                    deliveryStatus: DeliveryStatus.PENDING,
                    metadata: payload,
                    correlationId,
                });
            } catch (error) {
                this.logger.error({
                    message: `Failed to persist delivery row — skipping channel: ${channel}`,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    context: NotificationDispatcherService.name,
                    metadata: {
                        event,
                        channel,
                        recipientUserId: recipient.userId,
                        organizationId,
                        correlationId,
                    },
                });
                this.metricsCollector?.recordCounter(
                    'notification_deliveries_total',
                    1,
                    { channel, status: 'persist_failed' },
                );
                continue;
            }

            try {
                const context: NotificationDeliveryContext = {
                    deliveryId: delivery.uuid!,
                    userId: recipient.userId,
                    userEmail: recipient.email,
                    userRole: recipient.role,
                    organizationId,
                    event,
                    criticality: defaults.criticality,
                    title,
                    body,
                    ctaUrl,
                    category: defaults.category,
                    metadata: payload,
                    correlationId,
                };

                await adapter.deliver(context);
                await this.deliveryRepo.updateStatus(
                    delivery.uuid!,
                    DeliveryStatus.DELIVERED,
                );
                this.metricsCollector?.recordCounter(
                    'notification_deliveries_total',
                    1,
                    { channel, status: 'delivered' },
                );

                // Push SSE event for in-app channel
                if (channel === NotificationChannel.IN_APP) {
                    this.sseService.pushEvent(recipient.userId, {
                        type: 'notification',
                        data: {
                            id: delivery.uuid,
                            title,
                            category: defaults.category,
                            criticality: defaults.criticality,
                        },
                    });
                }
            } catch (error) {
                const errMsg =
                    error instanceof Error ? error.message : String(error);
                await this.handleDeliveryFailure({
                    delivery,
                    error,
                    errMsg,
                    attemptsSoFar: 1,
                    event,
                    channel,
                    criticality: defaults.criticality,
                    userId: recipient.userId,
                    correlationId,
                });
                // Isolated failure: don't block other channels.
            }
        }
    }

    /**
     * Re-attempt a previously failed delivery. Called by the
     * NotificationRetryService for rows the worker has claimed.
     *
     * Reconstructs the adapter context from the stored row (no
     * additional DB lookups), runs the channel's adapter once, and
     * either marks DELIVERED or routes through {@link handleDeliveryFailure}.
     */
    async redeliver(
        delivery: INotificationDelivery,
        attemptsSoFar: number,
    ): Promise<void> {
        const adapter = this.adapterMap.get(delivery.channel);
        if (!adapter) {
            await this.deliveryRepo.updateStatus(
                delivery.uuid!,
                DeliveryStatus.FAILED,
                `No adapter registered for channel ${delivery.channel}`,
            );
            return;
        }

        const context: NotificationDeliveryContext = {
            deliveryId: delivery.uuid!,
            userId: delivery.recipientUser?.uuid ?? '',
            userEmail: delivery.recipientEmail ?? '',
            userRole: delivery.recipientRole ?? 'contributor',
            organizationId: delivery.organization?.uuid ?? '',
            event: delivery.event as NotificationEvent,
            criticality: delivery.criticality,
            title: delivery.title,
            body: delivery.body,
            ctaUrl: delivery.ctaUrl,
            category: delivery.category,
            metadata: delivery.metadata ?? {},
            correlationId: delivery.correlationId,
        };

        try {
            await adapter.deliver(context);
            await this.deliveryRepo.updateStatus(
                delivery.uuid!,
                DeliveryStatus.DELIVERED,
            );
            this.metricsCollector?.recordCounter(
                'notification_deliveries_total',
                1,
                { channel: delivery.channel, status: 'delivered' },
            );

            if (delivery.channel === NotificationChannel.IN_APP) {
                this.sseService.pushEvent(context.userId, {
                    type: 'notification',
                    data: {
                        id: delivery.uuid,
                        title: delivery.title,
                        category: delivery.category,
                        criticality: delivery.criticality,
                    },
                });
            }
        } catch (error) {
            const errMsg =
                error instanceof Error ? error.message : String(error);
            await this.handleDeliveryFailure({
                delivery: { uuid: delivery.uuid },
                error,
                errMsg,
                attemptsSoFar,
                event: delivery.event as NotificationEvent,
                channel: delivery.channel,
                criticality: delivery.criticality,
                userId: context.userId,
                correlationId: delivery.correlationId,
            });
        }
    }

    /**
     * Shared failure handler used by both the initial dispatch path and
     * the retry worker. Schedules another attempt with backoff when the
     * criticality's retry budget allows; otherwise marks the row FAILED
     * and emits a structured alert log line for CRITICAL terminal
     * failures so the ops pipeline can page on it.
     */
    async handleDeliveryFailure(input: {
        delivery: { uuid?: string };
        error: unknown;
        errMsg: string;
        attemptsSoFar: number;
        event: NotificationEvent;
        channel: NotificationChannel;
        criticality: Criticality;
        userId: string;
        correlationId: string;
    }): Promise<void> {
        const decision = decideRetry(input.criticality, input.attemptsSoFar);
        const reason =
            (input.error as { name?: string })?.name || 'UnknownError';

        // Every failed attempt — retry-scheduled or terminal — bumps
        // the failures counter so we can chart failure rates by
        // channel/reason without losing transient ones to retry.
        this.metricsCollector?.recordCounter(
            'notification_delivery_failures_total',
            1,
            {
                channel: input.channel,
                reason,
                terminal: decision.shouldRetry ? 'false' : 'true',
            },
        );

        if (decision.shouldRetry) {
            await this.deliveryRepo.scheduleRetry(
                input.delivery.uuid!,
                decision.nextAttemptAt,
                input.errMsg,
            );
            this.logger.warn({
                message: `Channel delivery failed — scheduled retry: ${input.channel}`,
                error:
                    input.error instanceof Error
                        ? input.error
                        : new Error(input.errMsg),
                context: NotificationDispatcherService.name,
                metadata: {
                    event: input.event,
                    channel: input.channel,
                    criticality: input.criticality,
                    attemptsSoFar: input.attemptsSoFar,
                    maxAttempts: decision.maxAttempts,
                    nextAttemptAt: decision.nextAttemptAt,
                    userId: input.userId,
                    deliveryId: input.delivery.uuid,
                    correlationId: input.correlationId,
                },
            });
            return;
        }

        await this.deliveryRepo.updateStatus(
            input.delivery.uuid!,
            DeliveryStatus.FAILED,
            input.errMsg,
        );
        this.metricsCollector?.recordCounter(
            'notification_deliveries_total',
            1,
            { channel: input.channel, status: 'failed' },
        );

        if (input.criticality === Criticality.CRITICAL) {
            // Structured alert log line: terminal failure of a critical
            // notification. Picked up by the ops alerting pipeline via
            // the `alert: 'critical_notification_terminal_failure'` tag.
            this.logger.error({
                message:
                    'CRITICAL notification terminally failed after exhausting retries',
                error:
                    input.error instanceof Error
                        ? input.error
                        : new Error(input.errMsg),
                context: NotificationDispatcherService.name,
                metadata: {
                    alert: 'critical_notification_terminal_failure',
                    severity: 'page',
                    event: input.event,
                    channel: input.channel,
                    attempts: input.attemptsSoFar,
                    maxAttempts: decision.maxAttempts,
                    userId: input.userId,
                    deliveryId: input.delivery.uuid,
                    correlationId: input.correlationId,
                },
            });
            return;
        }

        this.logger.error({
            message: `Channel delivery failed permanently: ${input.channel}`,
            error:
                input.error instanceof Error
                    ? input.error
                    : new Error(input.errMsg),
            context: NotificationDispatcherService.name,
            metadata: {
                event: input.event,
                channel: input.channel,
                criticality: input.criticality,
                attempts: input.attemptsSoFar,
                maxAttempts: decision.maxAttempts,
                userId: input.userId,
                deliveryId: input.delivery.uuid,
                correlationId: input.correlationId,
            },
        });
    }

    /**
     * Resolves the explicit recipients on the message envelope into the
     * shape the rest of the dispatcher needs. The emitter is required to
     * have set them — we do not try to infer recipients from payload
     * fields anymore.
     */
    private async resolveRecipients(
        message: NotificationMessage,
        organizationId: string,
    ): Promise<ResolvedRecipient[]> {
        if (!message.recipients?.length) {
            this.logger.warn({
                message:
                    'Notification message has no recipients — nothing to dispatch',
                context: NotificationDispatcherService.name,
                metadata: {
                    event: message.event,
                    correlationId: message.correlationId,
                },
            });
            return [];
        }

        // Dedup map keyed by userId. When the same user is referenced
        // from multiple recipient entries (e.g. pr_author who is also a
        // role:OWNER), we keep the *first* channel override so the
        // semantics of the first match win. Email-only fallbacks live
        // under a "EMAIL:<addr>" pseudo-key.
        const byKey = new Map<string, ResolvedRecipient>();
        const remember = (
            entry: ResolvedRecipient | null,
            channels?: NotificationChannel[],
        ) => {
            if (!entry) return;
            const key = entry.userId ? entry.userId : `EMAIL:${entry.email}`;
            if (byKey.has(key)) return;
            byKey.set(key, channels ? { ...entry, channels } : entry);
        };

        for (const r of message.recipients) {
            switch (r.kind) {
                case 'user':
                    remember(
                        await this.resolveByUserId(r.userId),
                        r.channels,
                    );
                    break;
                case 'email':
                    remember(
                        await this.resolveByEmail(r.email, organizationId),
                        r.channels,
                    );
                    break;
                case 'role':
                    for (const entry of await this.resolveByRole(
                        r.role,
                        organizationId,
                    )) {
                        remember(entry, r.channels);
                    }
                    break;
                case 'all_org_members':
                    for (const entry of await this.resolveAllOrgMembers(
                        organizationId,
                    )) {
                        remember(entry, r.channels);
                    }
                    break;
            }
        }

        return [...byKey.values()];
    }

    private async resolveByRole(
        role: Role,
        organizationId: string,
    ): Promise<ResolvedRecipient[]> {
        const users = await this.usersService.find(
            { organization: { uuid: organizationId }, role },
            [STATUS.ACTIVE],
        );
        return (users ?? []).map((u) => ({
            userId: u.uuid,
            email: u.email,
            role: u.role ?? role,
        }));
    }

    private async resolveAllOrgMembers(
        organizationId: string,
    ): Promise<ResolvedRecipient[]> {
        const users = await this.usersService.find(
            { organization: { uuid: organizationId } },
            [STATUS.ACTIVE],
        );
        return (users ?? []).map((u) => ({
            userId: u.uuid,
            email: u.email,
            role: u.role ?? 'contributor',
        }));
    }

    private async resolveByUserId(
        userId: string,
    ): Promise<ResolvedRecipient | null> {
        // PENDING / PENDING_EMAIL users are exactly the ones who need to
        // receive AUTH_EMAIL_CONFIRMATION and TEAM_MEMBER_INVITED — they
        // can't transition to ACTIVE without first acting on the email
        // we're trying to send. INACTIVE/REMOVED users are still excluded
        // so a deleted account never gets re-engaged.
        const users = await this.usersService.find({ uuid: userId }, [
            STATUS.ACTIVE,
            STATUS.PENDING,
            STATUS.PENDING_EMAIL,
        ]);
        if (!users?.length) {
            this.logger.warn({
                message:
                    'Notification recipient userId did not resolve to a deliverable user — skipping',
                context: NotificationDispatcherService.name,
                metadata: { userId },
            });
            return null;
        }
        const u = users[0];
        return {
            userId: u.uuid,
            email: u.email,
            role: u.role ?? 'contributor',
        };
    }

    private async resolveByEmail(
        email: string,
        organizationId: string,
    ): Promise<ResolvedRecipient> {
        const users = await this.usersService.find(
            { email, organization: { uuid: organizationId } },
            [STATUS.ACTIVE, STATUS.PENDING, STATUS.PENDING_EMAIL],
        );
        if (users?.length) {
            return {
                userId: users[0].uuid,
                email: users[0].email,
                role: users[0].role ?? 'contributor',
            };
        }
        // No matching user — still emit on the email channel so flows
        // that target a not-yet-registered address (sign-up confirmation,
        // password reset, SSO verification) work. The in-app channel
        // will be skipped because there is no user uuid to attach to.
        this.logger.warn({
            message:
                'Notification recipient resolved by email-only fallback (no active user matched) — in-app channel will be skipped',
            context: NotificationDispatcherService.name,
            metadata: { email, organizationId },
        });
        return {
            userId: '',
            email,
            role: 'contributor',
        };
    }

    /**
     * The channels a (event, role) pair is delivered on, resolved in-memory
     * from the preloaded org rules:
     *
     *   - SYSTEM events: catalog defaults, role-independent (non-configurable).
     *   - A specific (event, role) row always wins.
     *   - Else the '*' ("All Roles") row applies — it is a literal baseline for
     *     every role, not just the default ones.
     *   - Else (no rows at all) the code fallback: a default role (or a directed
     *     recipient) gets the catalog defaults; any other role is off. This is
     *     what keeps orgs that were never seeded behaving correctly.
     *
     * Criticality no longer locks channels — critical events are configurable
     * like any other (their catalog defaults already cover every active
     * channel, so this only grants the ability to mute).
     *
     * Directed recipients do not go through here at all — they are resolved
     * to catalog defaults by the caller, so they are never gated off by an
     * off ('{}') wildcard baseline or a non-default role. Everything is
     * intersected with ACTIVE_CHANNELS.
     */
    private resolveEnabledChannels(
        ruleByKey: Map<string, IRoutingRule>,
        event: string,
        role: string,
        defaults: (typeof EVENT_DEFAULTS)[NotificationEvent],
    ): NotificationChannel[] {
        if (defaults.criticality === Criticality.SYSTEM) {
            return [...defaults.defaultChannels].filter((ch) =>
                ACTIVE_CHANNELS.has(ch),
            );
        }

        // A specific (event, role) row wins; otherwise the '*' baseline applies
        // to every role. Both are honored before the code fallback so the
        // stored config is the source of truth for seeded orgs. Lookups are
        // O(1) against the map the caller built once for the whole fanout.
        const specific = ruleByKey.get(`${event}:${role}`);
        if (specific) return this.activeEnabledChannels(specific.channels);

        const wildcard = ruleByKey.get(`${event}:${ROLE_WILDCARD}`);
        if (wildcard) return this.activeEnabledChannels(wildcard.channels);

        // No rows: fall back to the catalog defaults for default roles;
        // everyone else is off.
        const isDefaultRole =
            !defaults.defaultRoles ||
            (defaults.defaultRoles as readonly string[]).includes(role);
        if (isDefaultRole) {
            return [...defaults.defaultChannels].filter((ch) =>
                ACTIVE_CHANNELS.has(ch),
            );
        }
        return [];
    }

    private activeEnabledChannels(
        channels: Record<string, boolean>,
    ): NotificationChannel[] {
        return Object.entries(channels)
            .filter(
                ([ch, enabled]) =>
                    enabled && ACTIVE_CHANNELS.has(ch as NotificationChannel),
            )
            .map(([ch]) => ch as NotificationChannel);
    }

    /**
     * Resolve the in-app title/body/ctaUrl for an event from the
     * {@link IN_APP_TEMPLATE_REGISTRY}. Falls back to the catalog label
     * when no entry is registered. Used both to populate the
     * notification_deliveries row (for tracing / drawer) and to compose
     * SSE push payloads.
     */
    private resolveInAppTemplate(
        event: NotificationEvent,
        payload: Record<string, unknown>,
    ): { title: string; body: string; ctaUrl?: string } {
        const builder = IN_APP_TEMPLATE_REGISTRY[event];
        const defaults = EVENT_DEFAULTS[event];
        if (!builder) {
            return {
                title: defaults?.label ?? event,
                body: '',
            };
        }
        const tpl = builder(payload);
        return {
            title: tpl.title ?? defaults?.label ?? event,
            body: tpl.body ?? '',
            ctaUrl: tpl.ctaUrl,
        };
    }
}
