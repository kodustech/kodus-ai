import { BYOKProvider } from '@kodus/kodus-common/llm';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { resolveByokSlot } from './byok-credentials.util';
import {
    CURATED_CATALOG_PROVIDERS,
    GetModelsByProviderUseCase,
} from './get-models-by-provider.use-case';
import {
    TestByokConnectionUseCase,
    TestByokResult,
} from './test-byok-connection.use-case';

export interface TestByokModelInput {
    provider: string;
    model: string;
    organizationAndTeamData: OrganizationAndTeamData;
}

/**
 * Validate a specific model id against the org's ACTUAL saved BYOK provider —
 * the truthful "will this model work?" check the static model catalog on its own
 * can't give.
 *
 * Strategy:
 *  1. Check the provider's REAL model catalog (fetched with the org's own
 *     credentials, so it reflects e.g. a Moonshot proxy rather than OpenAI).
 *     If the model isn't offered → fail fast, no inference spend.
 *  2. When the provider can't be listed (anthropic_compatible, curated sets,
 *     or a listing error), fall back to the connection probe — which for
 *     baseURL providers sends a real 1-token request with the model.
 *
 * The client sends only {provider, model}; credentials are resolved server-side
 * and never leave the server.
 */
@Injectable()
export class TestByokModelUseCase {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly testByokConnectionUseCase: TestByokConnectionUseCase,
        private readonly getModelsByProviderUseCase: GetModelsByProviderUseCase,
    ) {}

    async execute(input: TestByokModelInput): Promise<TestByokResult> {
        const model = input.model?.trim();
        if (!model) {
            throw new BadRequestException('model is required');
        }

        const slot = await resolveByokSlot(
            this.organizationParametersService,
            input.provider,
            input.organizationAndTeamData,
        );
        if (!slot) {
            throw new BadRequestException(
                `No saved BYOK credentials found for provider "${input.provider}". Configure it in BYOK settings first.`,
            );
        }

        // 1) Authoritative catalog check (accurate — uses the org's own creds).
        const start = Date.now();
        const catalog = await this.getModelsByProviderUseCase
            .execute(input.provider, input.organizationAndTeamData)
            .catch(() => null);

        if (catalog?.models?.length) {
            const found = catalog.models.some((m) => m.id === model);
            if (found) {
                return { ok: true, code: 'ok', latencyMs: Date.now() - start };
            }
            // Bedrock/Vertex catalogs are CURATED (not exhaustive), so a miss
            // isn't proof the model is invalid — fall through to a real probe.
            // Other providers list authoritatively, so a miss is a real miss.
            if (!CURATED_CATALOG_PROVIDERS.has(input.provider as BYOKProvider)) {
                return {
                    ok: false,
                    code: 'not_found',
                    latencyMs: Date.now() - start,
                    message: `"${model}" isn't offered by your ${input.provider} provider.`,
                    providerMessage: `Model "${model}" is not in the provider's model list.`,
                };
            }
        }

        // 2) No/curated catalog → probe the provider directly with the model.
        return this.testByokConnectionUseCase.execute({
            provider: input.provider,
            model,
            apiKey: slot.apiKey,
            baseURL: slot.baseURL,
            vertexLocation: slot.vertexLocation,
            awsBearerToken: slot.awsBearerToken,
            awsAccessKeyId: slot.awsAccessKeyId,
            awsSecretAccessKey: slot.awsSecretAccessKey,
            awsRegion: slot.awsRegion,
            awsSessionToken: slot.awsSessionToken,
        });
    }
}
