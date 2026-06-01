import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    describeEnvLLMConfig,
    type EnvLLMProviderId,
} from '@libs/code-review/infrastructure/agents/llm/env-llm-config';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { Inject, Injectable } from '@nestjs/common';

import { isByokSlotConfigured, type BYOKSlot } from './byok-config.util';

export type LLMConfigSource = 'byok' | 'env' | 'none';

export interface LLMConfigStatus {
    source: LLMConfigSource;
    byok: {
        configured: boolean;
        model?: string;
        providerId?: string;
        baseUrl?: string;
    };
    env: {
        configured: boolean;
        model?: string;
        providerId?: EnvLLMProviderId;
        baseUrl?: string;
        vertexLocation?: string;
        /** Parsed `API_LLM_TEMPERATURE_OVERRIDE`; only present when set. */
        temperatureOverride?: number;
    };
}

@Injectable()
export class GetLLMConfigStatusUseCase implements IUseCase {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<LLMConfigStatus> {
        const parameter = await this.organizationParametersService
            .findByKey(
                OrganizationParametersKey.BYOK_CONFIG,
                organizationAndTeamData,
            )
            .catch(() => null);

        const byokMain = (
            parameter?.configValue as
                | { main?: Partial<BYOKSlot> }
                | undefined
        )?.main;

        // Provider-aware: most providers gate on `apiKey`, but Amazon
        // Bedrock authenticates with `awsBearerToken` / IAM credentials
        // and never sets `apiKey`. See `isByokSlotConfigured`.
        const byok = isByokSlotConfigured(byokMain)
            ? {
                  configured: true,
                  model: byokMain?.model,
                  providerId: byokMain?.provider,
                  baseUrl: byokMain?.baseURL,
              }
            : { configured: false };

        const envDescriptor = describeEnvLLMConfig();
        const env = envDescriptor.configured
            ? {
                  configured: true,
                  model: envDescriptor.model,
                  providerId: envDescriptor.providerId,
                  baseUrl: envDescriptor.baseUrl,
                  vertexLocation: envDescriptor.vertexLocation,
                  // Surfaced so the dashboard can show "your env clamps
                  // every LLM call to N" instead of leaving admins
                  // guessing why hard-coded prompt temperatures are
                  // ignored.
                  temperatureOverride: envDescriptor.temperatureOverride,
              }
            : { configured: false };

        const source: LLMConfigSource = byok.configured
            ? 'byok'
            : env.configured
              ? 'env'
              : 'none';

        return { source, byok, env };
    }
}
