import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { resolveByokSlot } from './byok-credentials.util';
import { isCuratedCatalogProvider } from '@libs/llm/providers';
import { GetModelsByProviderUseCase } from './get-models-by-provider.use-case';
import {
    TestByokConnectionUseCase,
    TestByokResult,
} from './test-byok-connection.use-case';

export interface TestByokModelInput {
    provider: string;
    model: string;
    organizationAndTeamData: OrganizationAndTeamData;
    // Optional NON-SECRET setting overrides from the edit form. When the user
    // changes an endpoint/region without re-entering the secret, the probe must
    // exercise the settings BEING SAVED, not the stored ones — otherwise a broken
    // new baseURL/region passes "Test & save" and is persisted broken. Secrets are
    // never accepted here (blank = keep the stored ciphertext, resolved server-side).
    baseURL?: string;
    awsRegion?: string;
    vertexLocation?: string;
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

        // Merge any NON-SECRET setting overrides (from an edit that changed the
        // endpoint/region but kept the stored secret) onto the resolved slot.
        const baseURL = input.baseURL?.trim() || slot.baseURL;
        const awsRegion = input.awsRegion?.trim() || slot.awsRegion;
        const vertexLocation = input.vertexLocation?.trim() || slot.vertexLocation;
        const changedSetting =
            (!!input.baseURL?.trim() && input.baseURL.trim() !== slot.baseURL) ||
            (!!input.awsRegion?.trim() &&
                input.awsRegion.trim() !== slot.awsRegion) ||
            (!!input.vertexLocation?.trim() &&
                input.vertexLocation.trim() !== slot.vertexLocation);

        // 1) Authoritative catalog check (accurate — uses the org's own creds).
        // SKIP it when a non-secret setting changed: the catalog is fetched with
        // the STORED endpoint/region, so it can't validate the new one — probe the
        // overridden endpoint directly instead (step 2) so a broken new setting is
        // caught here instead of being persisted.
        const start = Date.now();
        const catalog = changedSetting
            ? null
            : await this.getModelsByProviderUseCase
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
            if (!isCuratedCatalogProvider(input.provider)) {
                return {
                    ok: false,
                    code: 'not_found',
                    latencyMs: Date.now() - start,
                    message: `"${model}" isn't offered by your ${input.provider} provider.`,
                    providerMessage: `Model "${model}" is not in the provider's model list.`,
                };
            }
        }

        // 2) No/curated catalog (or a changed setting) → probe the provider
        // directly, using the overridden endpoint/region where the edit changed it.
        return this.testByokConnectionUseCase.execute({
            provider: input.provider,
            model,
            apiKey: slot.apiKey,
            baseURL,
            vertexLocation,
            awsBearerToken: slot.awsBearerToken,
            awsAccessKeyId: slot.awsAccessKeyId,
            awsSecretAccessKey: slot.awsSecretAccessKey,
            awsRegion,
            awsSessionToken: slot.awsSessionToken,
        });
    }
}
