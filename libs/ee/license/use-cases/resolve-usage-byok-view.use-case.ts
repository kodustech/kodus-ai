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

@Injectable()
export class ResolveUsageByokViewUseCase {
    private readonly logger = createLogger(ResolveUsageByokViewUseCase.name);

    constructor(
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        private readonly getLLMConfigStatusUseCase: GetLLMConfigStatusUseCase,
    ) {}

    async execute(params: {
        organizationId: string;
        teamId?: string;
    }): Promise<boolean> {
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
            return isByokUsageView({
                isCloud: false,
                license: null,
                llmSource: status?.source ?? null,
            });
        }

        const license = await this.licenseService
            .validateOrganizationLicense(organizationAndTeamData)
            .catch((error) => {
                this.logUnresolved('license', error, params);
                return null;
            });
        return isByokUsageView({ isCloud: true, license, llmSource: null });
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
