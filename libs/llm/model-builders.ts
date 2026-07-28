/**
 * Shared model builders (Phase 1, plan 01-02) — the vertex + bedrock construction
 * that has NO OpenAI-style one-liner. Extracted from byok-to-vercel.ts into a
 * dependency-free leaf so BOTH byok-to-vercel AND the new provider modules
 * (libs/llm/providers/{vertex,bedrock}.module) share ONE implementation — no
 * fork, no circular import (a module importing these from byok-to-vercel would
 * cycle once byok-to-vercel imports every module in 01-03).
 *
 * No runtime dependency on kodus-common (REQ-NOLC-01): the bedrock config is
 * typed structurally, not via BYOKConfig.
 */
import type { LanguageModel } from 'ai';
import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { decrypt } from '@libs/common/utils/crypto';

/** Claude model ids (e.g. claude-sonnet-4-6) — speak the Anthropic protocol. */
const CLAUDE_MODEL_PATTERN = /^claude[-_]/i;

/**
 * Normalize an Anthropic-compatible base URL to its root form (no trailing
 * slash, no `/v1` suffix). `@ai-sdk/anthropic` appends `/messages` to a
 * `/v1`-suffixed base, so callers append `/v1` themselves. (Mirrors the
 * kodus-common helper; kept here so the module layer needs no runtime import.)
 */
export function anthropicCompatibleRootURL(baseURL: string): string {
    let trimmed = baseURL.trim();
    while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
    if (/\/v1$/i.test(trimmed)) trimmed = trimmed.slice(0, -3);
    while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
    return trimmed;
}

/**
 * Parse a Google Service Account from either raw JSON or base64-encoded JSON.
 * Base64 of a JSON object always starts with `ey` (from `{"`), raw JSON with
 * `{`, so the leading char disambiguates. Returns null when neither yields JSON.
 */
function parseSaCredentials(input: string): { project_id?: string } | null {
    const trimmed = (input || '').trim();
    if (!trimmed) return null;
    const jsonText = trimmed.startsWith('{')
        ? trimmed
        : Buffer.from(trimmed, 'base64').toString('utf-8');
    try {
        return JSON.parse(jsonText) as { project_id?: string };
    } catch {
        return null;
    }
}

/**
 * Build a Vercel AI SDK model from a base64-encoded (or raw) Google Service
 * Account JSON. `claude-*` model ids on Vertex speak the Anthropic Messages
 * protocol (Vertex MaaS) and need `createVertexAnthropic`; every other id
 * (Gemini) uses `createVertex`. The caller passes the ALREADY-DECRYPTED SA
 * value and resolves the region (BYOK config or env) as `locationOverride`.
 * Returns null when the value is not a valid SA JSON with a `project_id`.
 */
export function vertexModelFromSaJson(
    saJsonOrBase64: string,
    modelId: string,
    locationOverride?: string,
): LanguageModel | null {
    try {
        const credentials = parseSaCredentials(saJsonOrBase64);
        if (!credentials?.project_id) return null;
        // Default to the GLOBAL endpoint when omitted — it serves every current
        // Claude and Gemini model on Vertex and routes dynamically (regional
        // endpoints like us-central1 don't serve Claude at all).
        const location = locationOverride?.trim() || 'global';
        const settings = {
            project: credentials.project_id,
            location,
            googleAuthOptions: { credentials: credentials as any },
        };
        if (CLAUDE_MODEL_PATTERN.test(modelId)) {
            return createVertexAnthropic(settings)(modelId);
        }
        return createVertex(settings)(modelId);
    } catch {
        return null;
    }
}

/** Bedrock auth fields (structural — no BYOKConfig import). aws* values are the
 *  ENCRYPTED ciphertext; this builder decrypts them internally. */
export interface BedrockCredentials {
    awsRegion?: string;
    awsBearerToken?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsSessionToken?: string;
}

/**
 * Build a Vercel AI SDK model for Amazon Bedrock. Two auth paths, in priority:
 *   1. Bearer API key (recommended) — takes precedence over any SigV4 config.
 *   2. Static IAM user credentials (SigV4) — legacy path.
 * Emits a clear auth error at call time when credentials are missing (the
 * test-byok endpoint already catches empty fields before save).
 */
export function bedrockModelFromCredentials(
    config: BedrockCredentials | undefined,
    modelId: string,
): LanguageModel {
    const region = config?.awsRegion?.trim() || 'us-east-1';

    if (config?.awsBearerToken?.trim()) {
        return createAmazonBedrock({
            region,
            apiKey: decrypt(config.awsBearerToken),
        })(modelId);
    }

    const accessKeyId = config?.awsAccessKeyId
        ? decrypt(config.awsAccessKeyId)
        : '';
    const secretAccessKey = config?.awsSecretAccessKey
        ? decrypt(config.awsSecretAccessKey)
        : '';
    const sessionToken = config?.awsSessionToken
        ? decrypt(config.awsSessionToken)
        : undefined;

    return createAmazonBedrock({
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
    })(modelId);
}
