import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostHog } from 'posthog-node';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

/**
 * NestJS DI token for the PostHog provider. Consumers inject the
 * interface via `@Inject(POSTHOG_PROVIDER_TOKEN) posthog: IPostHogProvider`
 * so the concrete class can be swapped in tests without rewriting every
 * call site (see kody rule "Inject services and repositories via DI
 * tokens, not by class").
 */
export const POSTHOG_PROVIDER_TOKEN = Symbol.for('PostHogProvider');

export interface IPostHogProvider {
    readonly isEnabled: boolean;

    capture(
        distinctId: string,
        event: string,
        properties?: Record<string, unknown>,
        groups?: Record<string, string | undefined>,
    ): void;

    identify(
        distinctId: string,
        properties?: Record<string, unknown>,
    ): void;

    groupIdentify(
        groupType:
            | 'organization'
            | 'team'
            | 'repository'
            | 'directory'
            | 'repositoryDirectory',
        groupKey: string,
        properties?: Record<string, unknown>,
    ): void;

    isFeatureEnabled(
        featureName: string,
        identifier: string,
        organizationAndTeamData: OrganizationAndTeamData,
        evaluationContext?: FeatureEvaluationContext,
    ): Promise<boolean>;
}

/**
 * Extra inputs PostHog uses to evaluate flag rules beyond the always-set
 * `organization` group. Each key becomes a PostHog `groups` entry
 * (one-id-per-type, the rollout boundary) — multi-id targeting is done
 * by the caller looping and evaluating once per id. Kept as a generic
 * bag so adding new group types (e.g. `user`) doesn't require changing
 * the call-site signature.
 */
export interface FeatureEvaluationContext {
    groups?: Record<string, string | undefined>;
}

@Injectable()
export class PostHogProvider implements IPostHogProvider {
    private readonly logger = createLogger(PostHogProvider.name);
    private readonly client: PostHog | null = null;

    constructor(configService: ConfigService) {
        const apiKey = configService.get<string>('API_POSTHOG_KEY');
        if (apiKey) {
            this.client = new PostHog(apiKey, {
                host: 'https://us.i.posthog.com',
            });
        }
    }

    get isEnabled(): boolean {
        return this.client !== null;
    }

    capture(
        distinctId: string,
        event: string,
        properties: Record<string, unknown> = {},
        groups: Record<string, string | undefined> = {},
    ): void {
        if (!this.client) return;

        try {
            this.client.capture({
                distinctId,
                event,
                properties,
                groups: this.cleanGroups(groups),
            });
        } catch (error) {
            this.swallow('capture', event, error);
        }
    }

    identify(
        distinctId: string,
        properties: Record<string, unknown> = {},
    ): void {
        if (!this.client) return;
        try {
            this.client.identify({ distinctId, properties });
        } catch (error) {
            this.swallow('identify', distinctId, error);
        }
    }

    groupIdentify(
        groupType:
            | 'organization'
            | 'team'
            | 'repository'
            | 'directory'
            | 'repositoryDirectory',
        groupKey: string,
        properties: Record<string, unknown> = {},
    ): void {
        if (!this.client) return;
        try {
            this.client.groupIdentify({ groupType, groupKey, properties });
        } catch (error) {
            this.swallow('groupIdentify', `${groupType}:${groupKey}`, error);
        }
    }

    /**
     * Evaluates a feature flag against PostHog. The `organization` group
     * is always set from `organizationAndTeamData.organizationId`; any
     * extra keys in `evaluationContext.groups` are merged in as
     * additional group keys. To target multiple values for the same
     * group type (e.g. several directories), the caller loops and
     * evaluates once per value. When no API key is configured (local
     * dev or self-hosted without telemetry) returns `true` to preserve
     * legacy permissive behavior — cloud-only callers should still gate
     * via the catalog stage.
     */
    async isFeatureEnabled(
        featureName: string,
        identifier: string,
        organizationAndTeamData: OrganizationAndTeamData,
        evaluationContext?: FeatureEvaluationContext,
    ): Promise<boolean> {
        if (!this.client) return true;

        const groups: Record<string, string> = {
            organization: organizationAndTeamData.organizationId,
        };
        for (const [key, value] of Object.entries(
            evaluationContext?.groups ?? {},
        )) {
            if (value) groups[key] = value;
        }

        try {
            const result = await this.client.isFeatureEnabled(
                featureName,
                identifier,
                { groups },
            );
            return result === true;
        } catch (error) {
            this.swallow('isFeatureEnabled', featureName, error);
            return false;
        }
    }

    private cleanGroups(
        groups: Record<string, string | undefined>,
    ): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(groups)) {
            if (v) out[k] = v;
        }
        return out;
    }

    private swallow(op: string, label: string, error: unknown): void {
        this.logger.warn({
            message: `PostHog ${op} threw for "${label}" (swallowed)`,
            context: PostHogProvider.name,
            metadata: {
                op,
                label,
                error: error instanceof Error ? error.message : String(error),
            },
        });
    }
}
