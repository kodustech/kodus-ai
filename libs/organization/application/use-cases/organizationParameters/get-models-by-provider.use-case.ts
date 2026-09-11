import { BYOKProvider } from '@libs/llm/model-providers';
import { REGISTRY } from '@libs/llm/providers';
import type { CatalogModel } from '@libs/llm/providers/kernel/types';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import { createLogger } from '@libs/core/log/logger';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import axios from 'axios';

import { resolveByokSlot } from './byok-credentials.util';
import { assertSafeOpenAICompatibleUrl } from './test-byok-connection.use-case';

export interface ModelResponse {
    provider: BYOKProvider;
    models: CatalogModel[];
    /**
     * Whether producing this list actually USED the organization's credential.
     *
     * A live listing authenticates, so its result is evidence the key works. A
     * static catalog is never fetched, and a curated fallback is served exactly
     * when the live call could not run — neither says anything about the key.
     *
     * Callers that treat "the model is listed" as "the credential is good" need
     * this to tell those apart: without it, a hard-coded array vouches for a
     * dead key, and a screen gated on that verdict will persist it.
     */
    exercisedCredential: boolean;
}

/**
 * Lists the models available for a BYOK provider — registry-driven. Each
 * provider module declares HOW to enumerate its models via a pure `modelListing`
 * descriptor (a static catalog, or a `/models` URL + headers + parse); this
 * use-case owns only the cross-cutting concerns the descriptor stays free of:
 * credential resolution, the SSRF gate, and the HTTP call.
 */
@Injectable()
export class GetModelsByProviderUseCase {
    private readonly logger = createLogger(GetModelsByProviderUseCase.name);

    constructor(
        private readonly providerService: ProviderService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(
        provider: string,
        organizationAndTeamData?: OrganizationAndTeamData,
        // A just-typed, UNSAVED credential from the connect form. Takes precedence
        // over the org's saved slot and env keys so the picker can live-list the
        // real models before the credential is persisted. When an apiKey is
        // supplied here, the http path is STRICT — a failed live call surfaces the
        // error instead of degrading to the curated placeholder (the user asked
        // for the real list, not a stand-in).
        //
        // awsBearerToken/awsRegion are Bedrock's equivalent of `apiKey` — Bedrock
        // never authenticates with a plain apiKey (see below), so a just-typed
        // bearer token needs its own field to reach the live call before save.
        // awsAccessKeyId/awsSecretAccessKey (IAM/SigV4) are deliberately NOT
        // candidate fields: SigV4 needs request signing, not a static header, so
        // an IAM-only connect can't be live-listed pre-save — it degrades to the
        // curated fallback below, same as it always has.
        candidate?: {
            apiKey?: string;
            baseURL?: string;
            awsBearerToken?: string;
            awsRegion?: string;
        },
    ): Promise<ModelResponse> {
        if (!this.providerService.isProviderSupported(provider)) {
            throw new BadRequestException(`Unsupported provider: ${provider}`);
        }

        const byokProvider = provider as BYOKProvider;
        const candidateKey = candidate?.apiKey?.trim() || undefined;
        const candidateBaseURL = candidate?.baseURL?.trim() || undefined;
        // Scoped to Bedrock: these fields mean nothing to any other provider's
        // listing (only bedrock/listing.ts reads awsBearerToken/awsRegion), so a
        // caller sending them alongside a different `provider` must not affect
        // that provider's strict/lenient fallback gate below.
        const isBedrockCandidate = byokProvider === BYOKProvider.AMAZON_BEDROCK;
        const candidateAwsBearerToken = isBedrockCandidate
            ? candidate?.awsBearerToken?.trim() || undefined
            : undefined;
        const candidateAwsRegion = isBedrockCandidate
            ? candidate?.awsRegion?.trim() || undefined
            : undefined;
        // Any candidate makes this a "the user is actively trying THIS
        // credential" request — strict-mode gate for both catch branches below.
        // Region is included because a bad/unreachable region fails the live
        // call regardless of how good the credential is — the user needs that
        // error surfaced, not a silent degrade to the curated placeholder.
        const hasCandidateCredential =
            !!candidateKey || !!candidateAwsBearerToken || !!candidateAwsRegion;

        const providerModule = REGISTRY.has(provider)
            ? REGISTRY.get(provider)
            : null;
        const listing = providerModule?.modelListing?.(provider) ?? null;

        if (!listing || listing.kind === 'manual') {
            // A brand with a `manual` listing and no live `/models` call (e.g.
            // Z.ai/GLM over the Anthropic protocol) can't be enumerated — the user
            // types the model id manually.
            throw new BadRequestException(
                `Model listing is not available for ${provider} — enter the model ID manually.`,
            );
        }

        if (listing.kind === 'static') {
            // Never fetched — a hand-maintained list that proves nothing about
            // the credential.
            return {
                provider: byokProvider,
                models: listing.models,
                exercisedCredential: false,
            };
        }

        // Prefer the org's OWN saved BYOK credentials so the catalog reflects the
        // user's actual endpoint/key (e.g. an openai_compatible proxy like
        // Moonshot) rather than Kodus' bundled env keys. Falls back to the
        // descriptor's env vars when no saved slot matches (e.g. setup wizard).
        const creds = await resolveByokSlot(
            this.organizationParametersService,
            byokProvider,
            organizationAndTeamData,
        );

        // A just-typed connect-form key wins over the saved slot and env keys, so
        // the picker lists the models THAT key can actually reach before it's saved.
        const apiKey =
            candidateKey ??
            creds?.apiKey ??
            (listing.apiKeyEnv ? process.env[listing.apiKeyEnv] : undefined);
        const baseURL =
            candidateBaseURL ??
            creds?.baseURL ??
            (listing.baseURLEnv
                ? process.env[listing.baseURLEnv] || undefined
                : undefined) ??
            listing.defaultBaseURL;
        // Amazon Bedrock authenticates the list call with a bearer token + region
        // (never an apiKey). A just-typed candidate wins over the saved slot, same
        // precedence as apiKey above, so a fresh connect can list live too.
        const awsBearerToken = candidateAwsBearerToken ?? creds?.awsBearerToken;
        const awsRegion = candidateAwsRegion ?? creds?.awsRegion;

        // The stand-in when the live call can't run: the http listing's own
        // fallbackModels (e.g. Bedrock's curated profiles), if the listing declares
        // any. No catalog fallback — a brand with no declared fallback surfaces the
        // failure and the user types the model id.
        const listingFallback = (): ModelResponse | null => {
            if (listing.fallbackModels?.length) {
                // Reached only when the live listing could not run, so the
                // credential was never exercised.
                return {
                    provider: byokProvider,
                    models: listing.fallbackModels,
                    exercisedCredential: false,
                };
            }
            return null;
        };

        // No usable creds yet (no api key AND no bearer token) — a NEW connect
        // where nothing resolves. The live call would 401, so fall back to the
        // curated list; the live list takes over once creds are supplied. Skipped
        // when the caller passed a candidate key (strict live).
        if (!apiKey && !awsBearerToken) {
            const fb = listingFallback();
            if (fb) return fb;
        }

        if (listing.requiresBaseURL) {
            if (!baseURL) {
                throw new BadRequestException(
                    `baseURL is required for ${provider}.`,
                );
            }
            // SSRF guard: a stored baseURL is user-controlled, so reject
            // private/reserved IPs, the cloud metadata endpoint, and non-https
            // before the request — the same guard the connection probe uses.
            await assertSafeOpenAICompatibleUrl(baseURL);
        }

        try {
            const response = await axios.get(
                listing.url({ apiKey, baseURL, awsBearerToken, awsRegion }),
                {
                    headers: listing.headers({
                        apiKey,
                        baseURL,
                        awsBearerToken,
                        awsRegion,
                    }),
                    // baseURL-driven providers: never follow redirects (a public URL
                    // could 302 onto a private IP / metadata endpoint past the guard).
                    ...(listing.requiresBaseURL ? { maxRedirects: 0 } : {}),
                    ...(listing.timeoutMs
                        ? { timeout: listing.timeoutMs }
                        : {}),
                },
            );

            // The live call authenticated, so this list IS evidence about the key.
            return {
                provider: byokProvider,
                models: listing.parse(response.data),
                exercisedCredential: true,
            };
        } catch (error) {
            // Live fetch failed (bad/expired key, provider down, parse error).
            // STRICT when the caller supplied a candidate credential (apiKey OR,
            // for Bedrock, a bearer token): the user is trying that specific
            // credential, so surface the failure (→ the UI's "type the model id"
            // fallback) rather than masking a bad key behind the curated list.
            // Only the keyless/saved path degrades to the curated catalog.
            if (!hasCandidateCredential) {
                const fb = listingFallback();
                if (fb) {
                    // Degrading to the curated list is otherwise invisible — the
                    // picker just shows a static set and the user reads it as
                    // "live". Log WHY so an expired/invalid saved credential (e.g.
                    // a lapsed Bedrock bearer token → 403 "Bearer Token has
                    // expired") is diagnosable instead of silent.
                    this.logger.warn({
                        message: `Live model listing for ${provider} failed; served curated fallback`,
                        context: GetModelsByProviderUseCase.name,
                        error: error as Error,
                        metadata: { provider },
                    });
                    return fb;
                }
            }
            throw new BadRequestException(
                `Error fetching ${provider} models: ${(error as Error).message}`,
            );
        }
    }
}
