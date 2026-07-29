import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    describeEnvLLMConfig,
    type EnvLLMProviderId,
} from '@libs/llm/env-llm-config';
import {
    isV2Config,
    type BYOKConfigV2,
    type BYOKCredential,
} from '@libs/llm/byok-config';
import { normalizeByokConfig } from '@libs/llm/normalize-byok-config';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { Inject, Injectable } from '@nestjs/common';

import {
    isByokSlotConfigured,
    isV2ModelResolvable,
    type BYOKSlot,
} from './byok-config.util';

export type LLMConfigSource = 'byok' | 'env' | 'none';

/**
 * One enumerated v2 model in the per-org status. Carries provider/model/baseUrl
 * METADATA ONLY — never any secret (apiKey / aws*). `resolvable` reports whether
 * the pipeline could actually run this model (credential present + provider set
 * + usable material, or env-default reachability for a managed model).
 */
export interface LLMModelStatus {
    modelId: string;
    model?: string;
    providerId?: string;
    baseUrl?: string;
    resolvable: boolean;
}

export interface LLMConfigStatus {
    source: LLMConfigSource;
    /**
     * Per-org enumeration of the configured v2 `models[]` with per-model
     * resolvability, secrets masked. Empty for a managed / non-v2 / empty
     * config (the single-slot `byok`/`env` fields still describe the effective
     * resolved slot for back-compat).
     */
    models: LLMModelStatus[];
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

        const configValue = parameter?.configValue;

        // v2-only (04b-06 — the legacy {main,fallback} read is GONE): derive the
        // effective "main" slot via normalizeByokConfig, which resolves
        // routing.defaultModelId → model → credential and yields absent `main` for
        // a managed / non-v2 / empty config (so it falls to env/none).
        const byokMain: Partial<BYOKSlot> | undefined = normalizeByokConfig(
            configValue,
        ).main as Partial<BYOKSlot> | undefined;

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

        // Multi-model view (05-07): enumerate every configured v2 model with
        // per-model resolvability, masking every secret. A managed / non-v2 /
        // empty config yields [] (the single-slot fields above still describe
        // the effective resolved slot). Uses the env descriptor's reachability
        // for managed models — no cloud call.
        const models = isV2Config(configValue)
            ? this.enumerateModels(configValue, envDescriptor.configured)
            : [];

        return { source, models, byok, env };
    }

    /**
     * Project each configured v2 model to a masked status entry. Only
     * model/provider/baseUrl METADATA is copied onto the result — the
     * credential's secret fields (apiKey / aws*) are read solely by
     * `isV2ModelResolvable` to compute the boolean and never leave this method.
     */
    private enumerateModels(
        config: BYOKConfigV2,
        envReachable: boolean,
    ): LLMModelStatus[] {
        const credentialsById = new Map<string, BYOKCredential>(
            (config.credentials ?? [])
                .filter((c) => c && c.id)
                .map((c) => [c.id, c]),
        );

        return (config.models ?? [])
            .filter((model) => model && model.id)
            .map((model) => {
                const credential = credentialsById.get(model.credentialId);
                const settings = (credential?.settings ?? {}) as Record<
                    string,
                    unknown
                >;
                const baseUrl =
                    typeof settings.baseURL === 'string'
                        ? settings.baseURL
                        : undefined;

                return {
                    modelId: model.id,
                    model: model.model,
                    providerId: credential?.provider,
                    baseUrl,
                    resolvable: isV2ModelResolvable(
                        model,
                        credential,
                        envReachable,
                    ),
                };
            });
    }
}
