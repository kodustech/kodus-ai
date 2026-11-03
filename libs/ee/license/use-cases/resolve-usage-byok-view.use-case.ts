import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { environment } from '@libs/ee/configs/environment';
import type { LLMConfigSource } from '@libs/llm/llm-config-status';
import { GetLLMConfigStatusUseCase } from '@libs/organization/application/use-cases/organizationParameters/get-llm-config-status.use-case';

import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
    OrganizationLicenseValidationResult,
    SubscriptionStatus,
} from '../interfaces/license.interface';

/**
 * Which token-usage bucket an organization reads: the BYOK one (isByok=true)
 * or the managed one. Same decision the Token Usage page makes
 * (apps/web/src/features/ee/token-usage/page.tsx): self-hosted keys off the
 * configured LLM source, cloud keys off the plan
 * (isBYOKSubscriptionPlan in apps/web/src/features/ee/byok/_utils.ts).
 */
export function isByokUsageView(params: {
    isCloud: boolean;
    license: OrganizationLicenseValidationResult | null;
    llmSource: LLMConfigSource | null;
}): boolean {
    if (!params.isCloud) {
        return params.llmSource === 'byok';
    }

    const license = params.license;
    if (!license) {
        return false;
    }

    switch (license.subscriptionStatus) {
        case SubscriptionStatus.SELF_HOSTED:
        case SubscriptionStatus.LICENSED_SELF_HOSTED:
        case SubscriptionStatus.TRIAL:
            return true;
        case SubscriptionStatus.ACTIVE:
            return (license.planType ?? '').includes('byok');
        default:
            return false;
    }
}

const CACHE_TTL_MS = 60 * 1000;

@Injectable()
export class ResolveUsageByokViewUseCase {
    private readonly logger = createLogger(ResolveUsageByokViewUseCase.name);

    constructor(
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        private readonly getLLMConfigStatusUseCase: GetLLMConfigStatusUseCase,
    ) {}

    // One `kodus usage tokens` sends the overview, the previous period and
    // a breakdown in parallel, each without `byok`: share one license/LLM
    // read per organization (in flight, then for a short while). A plan
    // change shows up within the TTL.
    private readonly cache = new Map<
        string,
        { expiresAt: number; value: Promise<boolean> }
    >();

    async execute(params: {
        organizationId: string;
        teamId?: string;
    }): Promise<boolean> {
        const key = `${params.organizationId}:${params.teamId ?? ''}`;
        const cached = this.cache.get(key);
        if (cached && Date.now() < cached.expiresAt) {
            return cached.value;
        }
        const read = this.resolve(params);
        const value = read.then((result) => result.byok);
        this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
        // Only a read that got an answer is kept; after a failure (which
        // falls back to managed) the next request tries again.
        void read.then(
            (result) => {
                if (!result.answered) this.cache.delete(key);
            },
            () => this.cache.delete(key),
        );
        return value;
    }

    private async resolve(params: {
        organizationId: string;
        teamId?: string;
    }): Promise<{ byok: boolean; answered: boolean }> {
        const organizationAndTeamData = {
            organizationId: params.organizationId,
            teamId: params.teamId,
        };

        if (!environment.API_CLOUD_MODE) {
            const status = await this.getLLMConfigStatusUseCase
                .execute(organizationAndTeamData)
                .catch((error) => {
                    this.logUnresolved('LLM config status', error, params);
                    return null;
                });
            return {
                byok: isByokUsageView({
                    isCloud: false,
                    license: null,
                    llmSource: status?.source ?? null,
                }),
                answered: status !== null,
            };
        }

        const license = await this.licenseService
            .validateOrganizationLicense(organizationAndTeamData)
            .catch((error) => {
                this.logUnresolved('license', error, params);
                return null;
            });
        return {
            byok: isByokUsageView({ isCloud: true, license, llmSource: null }),
            // The cloud license service answers a billing failure with
            // `{ valid: false }` and no status rather than throwing.
            answered: !!license?.subscriptionStatus,
        };
    }

    // The page falls back the same way when its reads fail; log it so a
    // usage view that reads managed for a BYOK org can be traced.
    private logUnresolved(
        what: string,
        error: unknown,
        params: { organizationId: string; teamId?: string },
    ): void {
        this.logger.warn({
            message: `Token usage view: ${what} unreadable, showing the managed bucket`,
            context: ResolveUsageByokViewUseCase.name,
            error: error instanceof Error ? error : undefined,
            metadata: {
                organizationId: params.organizationId,
                teamId: params.teamId,
            },
        });
    }
}
