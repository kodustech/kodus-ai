/**
 * Pure helpers shared by provider `modelListing` descriptors. No HTTP, no
 * NestJS — the org-layer fetcher owns the request/SSRF; these only shape URLs,
 * headers and parsed catalogs.
 */
import { reasoningConfigForModel } from './model-reasoning';
import type { CatalogModel } from './types';

/** Catalog entry that derives reasoning support from the family owner (the single
 *  source — see model-reasoning.ts). `capKey` lets curated ids (e.g. Bedrock's
 *  `us.anthropic.*`) resolve reasoning by their bare model name. */
export function catalogWithReasoning(
    id: string,
    name: string = id,
    capKey: string = id,
): CatalogModel {
    const reasoningConfig = reasoningConfigForModel(capKey);
    return {
        id,
        name,
        ...(reasoningConfig && {
            supportsReasoning: true as const,
            reasoningConfig,
        }),
    };
}

/** Standard `Bearer` auth headers for OpenAI-style `/models` endpoints. */
export function bearerHeaders(apiKey?: string): Record<string, string> {
    return {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };
}

/** Parse an OpenAI-style `{ data: [{ id }] }` list into plain `{id, name}`
 *  entries (no reasoning derivation — used by gateways that just proxy ids). */
export function parseOpenAiIds(body: unknown): CatalogModel[] {
    const data =
        (body as { data?: Array<{ id: string }> } | undefined)?.data ?? [];
    return data.map((m) => ({ id: m.id, name: m.id }));
}

/** Build a `/models` URL from a self-hosted / proxy baseURL, mirroring the
 *  connection probe: trim trailing slashes, then only add `/v1` when the base
 *  isn't already versioned (so `https://api.moonshot.ai/v1` → `…/v1/models`,
 *  not `…/v1/v1/models`). */
export function openAiCompatibleModelsUrl(baseURL: string): string {
    let trimmed = baseURL;
    while (trimmed.endsWith('/')) {
        trimmed = trimmed.slice(0, -1);
    }
    const needsV1 = !/\/v\d+$/i.test(trimmed);
    return needsV1 ? `${trimmed}/v1/models` : `${trimmed}/models`;
}
