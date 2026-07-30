import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { NotificationEvent } from '../domain/catalog/events';
import {
    CATEGORY_LABELS,
    CHANNEL_LABELS,
    CRITICALITY_LABELS,
    EVENT_DEFAULTS,
    ROLE_LABELS,
    ROLE_WILDCARD,
} from '../domain/catalog/defaults';
import {
    Criticality,
    ACTIVE_CHANNELS,
    NotificationChannel,
} from '../domain/enums';
import {
    IRoutingRuleRepository,
    ROUTING_RULE_REPOSITORY_TOKEN,
} from '../domain/contracts/routing-rule.repository.contract';
import { IRoutingRule } from '../domain/interfaces/routing-rule.interface';

export interface NotificationConfigEvent {
    event: string;
    label: string;
    category: string;
    criticality: Criticality;
    defaultChannels: Record<string, boolean>;
    icon?: string;
    pageSeverity?: boolean;
    actionLabel?: string;
    /**
     * Roles this event actually reaches (role-fanout events only). When set,
     * the settings UI should offer per-role routing for these roles only.
     * Absent = directed at a specific user/email or any role — show all.
     */
    defaultRoles?: string[];
}

export interface NotificationConfig {
    events: NotificationConfigEvent[];
    channels: Array<{ value: NotificationChannel; label: string }>;
    criticalities: Array<{ value: Criticality; label: string }>;
    categories: Array<{ value: string; label: string }>;
    roles: Array<{ value: string; label: string }>;
}

export interface UpsertRuleDto {
    event: string;
    role: string;
    channels: Record<string, boolean>;
    /**
     * When true, removes the (event, role) routing rule for this org so it
     * inherits from the wildcard rule. Used by the admin UI to revert a
     * per-role override.
     */
    delete?: boolean;
}

/**
 * CRUD for owner-managed routing rules + critical event enforcement.
 */
@Injectable()
export class RoutingRuleService {
    constructor(
        @Inject(ROUTING_RULE_REPOSITORY_TOKEN)
        private readonly routingRuleRepo: IRoutingRuleRepository,
    ) {}

    async findByOrganization(organizationId: string): Promise<IRoutingRule[]> {
        return this.routingRuleRepo.findByOrganization(organizationId);
    }

    /**
     * Full notification configuration consumed by the in-app UI:
     *
     *  - events: per-event catalog metadata (label, category,
     *    criticality, defaults, icon hint, banner-severity flag, CTA
     *    label).
     *  - channels / criticalities / categories / roles: display labels
     *    for the four axes the settings UI renders.
     *
     * Everything the frontend needs to render notifications and the
     * settings page is here — adding a new event or a new channel
     * never requires a frontend change.
     */
    getConfig(): NotificationConfig {
        const events: NotificationConfigEvent[] = Object.entries(
            EVENT_DEFAULTS,
        ).map(([event, defaults]) => {
            const defaultChannels: Record<string, boolean> = {};
            for (const ch of ACTIVE_CHANNELS) {
                defaultChannels[ch] = defaults.defaultChannels.has(ch);
            }
            return {
                event,
                label: defaults.label,
                category: defaults.category,
                criticality: defaults.criticality,
                defaultChannels,
                icon: defaults.icon,
                // Only meaningful when criticality === CRITICAL; the
                // catalog declaration is responsible for not setting it
                // on lower severities.
                pageSeverity:
                    defaults.criticality === Criticality.CRITICAL
                        ? defaults.pageSeverity
                        : undefined,
                actionLabel: defaults.actionLabel,
                defaultRoles: defaults.defaultRoles
                    ? [...defaults.defaultRoles]
                    : undefined,
            };
        });

        const channels = [...ACTIVE_CHANNELS].map((value) => ({
            value,
            label: CHANNEL_LABELS[value] ?? value,
        }));

        const criticalities = Object.values(Criticality).map((value) => ({
            value,
            label: CRITICALITY_LABELS[value] ?? value,
        }));

        const presentCategories = [
            ...new Set(events.map((e) => e.category)),
        ];
        const categories = presentCategories.map((value) => ({
            value,
            label: CATEGORY_LABELS[value] ?? value,
        }));

        // Wildcard first so the settings UI renders it as the leading
        // "All Roles" tab without needing client-side sorting.
        const roleOrder: string[] = [
            ROLE_WILDCARD,
            Role.OWNER,
            Role.BILLING_MANAGER,
            Role.REPO_ADMIN,
            Role.CONTRIBUTOR,
        ];
        const roles = roleOrder.map((value) => ({
            value,
            label: ROLE_LABELS[value] ?? value,
        }));

        return { events, channels, criticalities, categories, roles };
    }

    async upsertRules(
        organizationId: string,
        rules: UpsertRuleDto[],
    ): Promise<IRoutingRule[]> {
        for (const rule of rules) {
            const eventDefaults =
                EVENT_DEFAULTS[rule.event as NotificationEvent];
            if (!eventDefaults) continue;

            // System events are non-configurable: their channels come
            // from the catalog defaults and cannot be overridden.
            if (eventDefaults.criticality === Criticality.SYSTEM) {
                throw new BadRequestException(
                    `Cannot configure routing for system event "${rule.event}". System notifications use catalog defaults.`,
                );
            }

            // Critical events are no longer locked: every non-system event is
            // freely configurable per role, criticality included.
        }

        const toDelete = rules.filter((r) => r.delete);
        const toUpsert = rules.filter((r) => !r.delete);

        for (const r of toDelete) {
            // Wildcard rules are the global config and cannot be "removed" via
            // override-revert — only specific-role rows are deletable here.
            if (r.role === '*') {
                throw new BadRequestException(
                    `Cannot delete wildcard routing rule for "${r.event}". The All Roles config is the global default.`,
                );
            }
            await this.routingRuleRepo.deleteByOrgEventRole(
                organizationId,
                r.event,
                r.role,
            );
        }

        if (toUpsert.length === 0) {
            return this.findByOrganization(organizationId);
        }

        return this.routingRuleRepo.upsertBatch(
            toUpsert.map((r) => ({
                organization: { uuid: organizationId },
                event: r.event,
                role: r.role,
                category:
                    EVENT_DEFAULTS[r.event as NotificationEvent]?.category ??
                    null,
                channels: r.channels,
            })),
        );
    }

    /**
     * Seed default routing rules for a new organization.
     * Called once when the org is created. System events are skipped — they
     * are non-configurable and the dispatcher hardcodes them to email-only.
     */
    async seedDefaults(organizationId: string): Promise<IRoutingRule[]> {
        const rules: Array<
            Omit<IRoutingRule, 'uuid' | 'createdAt' | 'updatedAt'>
        > = [];

        for (const [event, defaults] of Object.entries(EVENT_DEFAULTS)) {
            if (defaults.criticality === Criticality.SYSTEM) continue;

            const channels: Record<string, boolean> = {};
            for (const ch of ACTIVE_CHANNELS) {
                channels[ch] = defaults.defaultChannels.has(ch);
            }

            const base = (role: string, ch: Record<string, boolean>) => ({
                organization: { uuid: organizationId },
                event,
                category: defaults.category,
                role,
                channels: ch,
            });

            if (defaults.defaultRoles?.length) {
                // Role-fanout event: '*' is an off baseline (so non-default
                // roles inherit nothing) and each default role gets the
                // catalog channels via an explicit override row.
                rules.push(base(ROLE_WILDCARD, {}));
                for (const role of defaults.defaultRoles) {
                    rules.push(base(role, channels));
                }
            } else {
                // Directed event (no role-fanout): '*' carries the catalog
                // defaults so directly-targeted recipients deliver on them.
                rules.push(base(ROLE_WILDCARD, channels));
            }
        }

        return this.routingRuleRepo.upsertBatch(rules);
    }

    async resetToDefaults(organizationId: string): Promise<IRoutingRule[]> {
        await this.routingRuleRepo.deleteByOrganization(organizationId);
        return this.seedDefaults(organizationId);
    }
}
