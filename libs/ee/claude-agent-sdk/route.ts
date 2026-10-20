/**
 * Where a Claude slot's requests go, once it is known to run on the Agent SDK.
 *
 * The CLI speaks Anthropic Messages in one of three envelopes; the gateway holds
 * the credential for the one the slot uses. Secrets here are already decrypted,
 * in the worker's memory only — the subprocess never sees them.
 */
export interface AnthropicFormatRoute {
    format: 'anthropic';
    /** Upstream root, without `/v1` (the CLI's path starts at `/v1/messages`). */
    baseUrl: string;
    apiKey: string;
    /** First-party Anthropic answers `x-api-key`; OpenRouter and most proxies a bearer. */
    auth: 'x-api-key' | 'bearer';
    /** Anthropic itself, or Kodus/self-hosted keys on it. Off → experimental betas off. */
    firstParty: boolean;
    /** OpenRouter only: the slot's provider routing, added to every body. */
    openrouterProvider?: { order: string[]; allow_fallbacks: boolean };
}

export interface VertexRoute {
    format: 'vertex';
    project: string;
    region: string;
    /** Service account JSON, or `adc` for the ambient credentials. */
    credentials: Record<string, unknown> | 'adc';
    /** Endpoint origin; the region's public one when absent. */
    endpoint?: string;
    firstParty: true;
}

export interface BedrockRoute {
    format: 'bedrock';
    region: string;
    auth:
        | { kind: 'bearer'; token: string }
        | { kind: 'sigv4'; accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    /** Runtime endpoint origin; the region's public one when absent. */
    endpoint?: string;
    firstParty: true;
}

export type SdkRoute = AnthropicFormatRoute | VertexRoute | BedrockRoute;

/** Model id the CLI is given: what the upstream calls the slot's model. */
export interface ResolvedSdkRoute {
    route: SdkRoute;
    model: string;
}
