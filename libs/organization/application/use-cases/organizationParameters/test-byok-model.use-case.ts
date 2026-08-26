import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { resolveByokSlot } from './byok-credentials.util';
import { isCuratedCatalogProvider } from '@libs/llm/providers';
import { createLogger } from '@libs/core/log/logger';
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
    // changes a region/location without re-entering the secret, the probe must
    // exercise the settings BEING SAVED, not the stored ones — otherwise a broken
    // new region passes "Test & save" and is persisted broken.
    //
    // baseURL is DELIBERATELY NOT accepted here: this path reuses the org's STORED
    // secret (resolved server-side), and the stored secret must never be sent to a
    // caller-supplied host — that would let an authorized caller exfiltrate a
    // credential they are not allowed to read (the URL guard only blocks private
    // IPs, not arbitrary public hosts). Changing an endpoint requires re-entering
    // the key, which flows through the connection probe with the caller's OWN key.
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
    private readonly logger = createLogger(TestByokModelUseCase.name);

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

        // Merge only the SAFE non-secret overrides (region/location) onto the
        // resolved slot. These compose into provider-owned endpoints server-side,
        // so reusing the stored secret with them can't redirect it to a caller-
        // chosen host. baseURL is intentionally NOT overridable here (see the input
        // type) — the stored secret must never travel to a caller-supplied URL.
        const awsRegion = input.awsRegion?.trim() || slot.awsRegion;
        const vertexLocation = input.vertexLocation?.trim() || slot.vertexLocation;
        const changedSetting =
            (!!input.awsRegion?.trim() &&
                input.awsRegion.trim() !== slot.awsRegion) ||
            (!!input.vertexLocation?.trim() &&
                input.vertexLocation.trim() !== slot.vertexLocation);

        // 1) Authoritative catalog check (accurate — uses the org's own creds).
        // SKIP it when a non-secret setting changed: the catalog is fetched with
        // the STORED region/location, so it can't validate the new one — probe the
        // overridden endpoint directly instead (step 2) so a broken new setting is
        // caught here instead of being persisted.
        const start = Date.now();
        const catalog = changedSetting
            ? null
            : await this.getModelsByProviderUseCase
                  .execute(input.provider, input.organizationAndTeamData)
                  .catch((error) => {
                      // A listing failure is an EXPECTED fallback (provider not
                      // enumerable), not a hard error — but trace it so a silently
                      // unlistable provider is diagnosable.
                      this.logger.warn({
                          message:
                              'BYOK provider catalog fetch failed; falling back to a direct connection probe',
                          context: TestByokModelUseCase.name,
                          error,
                          metadata: {
                              provider: input.provider,
                              organizationId:
                                  input.organizationAndTeamData?.organizationId,
                              organizationAndTeamData:
                                  input.organizationAndTeamData,
                          },
                      });
                      return null;
                  });

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

        // 2) No/curated catalog (or a changed region/location) → probe the provider
        // directly. baseURL stays the STORED one (never a caller override); the
        // region/location use the overridden value where the edit changed it.
        return this.testByokConnectionUseCase.execute({
            provider: input.provider,
            model,
            apiKey: slot.apiKey,
            baseURL: slot.baseURL,
            vertexLocation,
            awsBearerToken: slot.awsBearerToken,
            awsAccessKeyId: slot.awsAccessKeyId,
            awsSecretAccessKey: slot.awsSecretAccessKey,
            awsRegion,
            awsSessionToken: slot.awsSessionToken,
        });
    }
}
