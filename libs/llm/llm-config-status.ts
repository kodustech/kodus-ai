/**
 * The per-org LLM-config STATUS projection — pure LLM logic, no DB, no NestJS.
 * Given a stored BYOK_CONFIG blob (the org use-case fetches it), describe the
 * effective config: the resolved default slot, the env/managed fallback, and a
 * per-model resolvability + capability view for the routing UI.
 *
 * Lives in @libs/llm (the kernel) so the whole projection — slot resolvability,
 * env descriptor, per-model capabilities from the registry — is defined and
 * tested in ONE place; the organization use-case is a thin DB shell that fetches
 * the blob and calls `describeLLMConfigStatus`.
 */
import { BYOKProvider } from './model-providers';
import {
    isByokConfig,
    type BYOKConfig,
    type BYOKCredential,
    type BYOKModelConfig,
    type NormalizedModel,
} from './byok-config';
import { resolveDefaultSlot } from './resolve-model-slot';
import { describeEnvLLMConfig, type EnvLLMProviderId } from './env-llm-config';
// Barrel import (side-effect self-registers every provider module), so
// REGISTRY.get(providerId).capabilities(model) resolves for all BYOKProvider ids.
import { REGISTRY } from './providers';

const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Whether a BYOK credential slot carries the credentials it needs to run.
 *
 * Most providers authenticate with a single `apiKey` — Google Vertex stores its
 * base64-encoded service-account JSON in that same field, so it is covered too.
 * Amazon Bedrock is the exception: it has no `apiKey` and authenticates with
 * either a bearer token (`awsBearerToken`) or static IAM credentials
 * (`awsAccessKeyId` + `awsSecretAccessKey`).
 *
 * Keep in sync with the auth paths in `bedrockModelFromCredentials`
 * (byok-to-vercel.ts) and the save-time validation in `encryptSlot`
 * (create-or-update.use-case.ts).
 */
export function isByokSlotConfigured(
    slot: Partial<NormalizedModel> | null | undefined,
): boolean {
    if (!slot) {
        return false;
    }

    if (slot.provider === BYOKProvider.AMAZON_BEDROCK) {
        return Boolean(
            slot.awsBearerToken ||
                (slot.awsAccessKeyId && slot.awsSecretAccessKey),
        );
    }

    return Boolean(slot.apiKey);
}

/**
 * Per-model resolvability for the multi-model status (05-07).
 *
 * A model "resolves" when the pipeline could actually run it:
 *  - a MANAGED / env-default credential → resolves iff the env-default LLM is
 *    reachable (`describeEnvLLMConfig().configured`), because a managed model
 *    normalizes to the env path and carries no BYOK material of its own;
 *  - a real BYOK credential → resolves iff the provider is set, the model names
 *    a model, and the credential carries usable material for its provider
 *    (`isByokSlotConfigured`, including Bedrock's aws* auth).
 *
 * Only credential MATERIAL is inspected here to build the boolean — the caller
 * must never surface the reconstructed slot's secret fields. Nothing secret is
 * returned; the function yields a boolean only.
 */
export function isV2ModelResolvable(
    model: Pick<BYOKModelConfig, 'model' | 'credentialId'> | null | undefined,
    credential: BYOKCredential | null | undefined,
    envReachable: boolean,
): boolean {
    if (!model || !credential) {
        return false;
    }

    // A managed credential is the Kodus env-default; it resolves only when the
    // env-default LLM is actually reachable on this self-hosted install.
    if (credential.managed) {
        return envReachable;
    }

    if (!asString(credential.provider) || !asString(model.model)) {
        return false;
    }

    const settings = (credential.settings ?? {}) as Record<string, unknown>;
    // Reconstruct only the provider + auth-material fields the provider-aware
    // `isByokSlotConfigured` check reads. This local slot is NEVER returned.
    const slot: Partial<NormalizedModel> = {
        provider: credential.provider as NormalizedModel['provider'],
        apiKey: asString(credential.apiKey),
        awsBearerToken: asString(settings.awsBearerToken),
        awsAccessKeyId: asString(settings.awsAccessKeyId),
        awsSecretAccessKey: asString(settings.awsSecretAccessKey),
    };

    return isByokSlotConfigured(slot);
}

export type LLMConfigSource = 'byok' | 'env' | 'none';

/**
 * One enumerated model in the per-org status. Carries provider/model/baseUrl
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
    /**
     * Static per-model capability descriptor derived from
     * REGISTRY.get(providerId).capabilities(model). METADATA ONLY (never a
     * secret) — surfaced so the Routing tab can render a LIVE pre-save
     * capability warning. Absent (undefined) for an unknown/unregistered
     * provider; the backend StaticTaskStrategy stays the authoritative gate.
     */
    capabilities?: { structuredOutput?: string; toolCalling?: string };
}

export interface LLMConfigStatus {
    source: LLMConfigSource;
    /**
     * Per-org enumeration of the configured `models[]` with per-model
     * resolvability, secrets masked. Empty for a managed / non-config / empty
     * blob (the single-slot `byok`/`env` fields still describe the effective
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

/**
 * Static per-model capability descriptor from the provider registry. Returns the
 * two gate-relevant fields (structuredOutput / toolCalling) — a plain descriptor
 * with NO secret. Degrades to `undefined` (never throws) for a
 * missing/unknown/unregistered provider or a failing capabilities() lookup,
 * mirroring StaticTaskStrategy.evaluate's try/catch degrade.
 */
function modelCapabilities(
    providerId?: string,
    model?: string,
): { structuredOutput?: string; toolCalling?: string } | undefined {
    if (!providerId || !model || !REGISTRY.has(providerId)) {
        return undefined;
    }
    try {
        const caps = REGISTRY.get(providerId).capabilities(model);
        return {
            structuredOutput: caps.structuredOutput,
            toolCalling: caps.toolCalling,
        };
    } catch {
        return undefined;
    }
}

/**
 * Project each configured model to a masked status entry. Only
 * model/provider/baseUrl METADATA is copied onto the result — the credential's
 * secret fields (apiKey / aws*) are read solely by `isV2ModelResolvable` to
 * compute the boolean and never leave this function.
 */
function enumerateModels(
    config: BYOKConfig,
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
                resolvable: isV2ModelResolvable(model, credential, envReachable),
                capabilities: modelCapabilities(credential?.provider, model.model),
            };
        });
}

/**
 * Describe the effective LLM config for a stored BYOK_CONFIG blob (secrets
 * masked). Pure: no DB, no cloud call — the org use-case fetches the blob and
 * calls this. A managed / non-config / empty blob yields `models: []` and falls
 * to the env/none source.
 */
export function describeLLMConfigStatus(configValue: unknown): LLMConfigStatus {
    // The effective default slot: routing.defaultModelId's model, else the first
    // configured model. undefined for a managed / non-config / empty blob.
    const byokMain: Partial<NormalizedModel> | undefined =
        resolveDefaultSlot(configValue);

    // Provider-aware: most providers gate on `apiKey`, but Amazon Bedrock
    // authenticates with `awsBearerToken` / IAM credentials and never sets
    // `apiKey`. See `isByokSlotConfigured`.
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
              // Surfaced so the dashboard can show "your env clamps every LLM
              // call to N" instead of leaving admins guessing why hard-coded
              // prompt temperatures are ignored.
              temperatureOverride: envDescriptor.temperatureOverride,
          }
        : { configured: false };

    const source: LLMConfigSource = byok.configured
        ? 'byok'
        : env.configured
          ? 'env'
          : 'none';

    // Multi-model view: enumerate every configured model with per-model
    // resolvability, masking every secret. A managed / non-config / empty blob
    // yields []. Uses the env descriptor's reachability for managed models — no
    // cloud call.
    const models = isByokConfig(configValue)
        ? enumerateModels(configValue, envDescriptor.configured)
        : [];

    return { source, models, byok, env };
}
