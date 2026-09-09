/**
 * Kodus provider module — id `kodus`. "Kodus as the provider."
 *
 * The org picks a model from a curated catalog and Kodus routes the call over
 * ITS OWN upstream accounts (Fireworks today — DeepSeek / Kimi / GLM; the
 * Anthropic, OpenAI and Google upstreams stay wired for a later catalog). The
 * stored credential
 * carries NO key — the runtime reads Kodus's platform keys from env at build
 * time — and the org is billed for the usage from its Kodus credits at the
 * catalog's list price (./catalog.ts is the price list).
 *
 * This is a ROUTING BRAND, in the same spirit as `anthropicBrandModule`: the
 * module owns identity + catalog, and every protocol behavior (build, reasoning,
 * cache hint, sampling-param gate, usage extraction) delegates to the upstream's
 * own module by re-presenting the config under the upstream provider id with
 * the bare model id. So a `kodus:anthropic/claude-sonnet-5` slot gets native
 * Anthropic transport — `cache_control` breakpoints included — exactly as a
 * customer's own Anthropic key would, which is the whole point: a gateway shim
 * loses the cache and 3-5×s the bill.
 *
 * Model ids are `<upstream>/<model>`
 * (`fireworks/accounts/fireworks/models/deepseek-v4-flash-0731`). The catalog
 * is CLOSED: an id
 * it does not list has no price, cannot be billed, and therefore must not run —
 * `capabilities()` answers non-routable for it and `build()` refuses it.
 *
 * Cloud-only. The org layer (`isKodusProviderAvailable`) hides the module from
 * the picker and rejects a stored credential on self-hosted installs; the
 * registry itself does not know about deployment mode.
 */
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { REGISTRY, registerProvider } from '../kernel/registry';
import {
    NON_REASONING_TRAITS,
    type ModelReasoningTraits,
} from '../kernel/reasoning-traits';
import type { TemperaturePolicy } from '../kernel/model-types';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';
import { normalizeSdkResult, normalizeSdkUsage } from '../kernel/usage';
import { isKodusCatalogModel, kodusModelListing } from './catalog';
import {
    KODUS_UPSTREAMS,
    splitKodusModelId,
    type KodusModelRef,
    type KodusUpstream,
} from './model-id';

export { KODUS_UPSTREAMS, splitKodusModelId, type KodusModelRef };
// Side-effect imports so the upstream modules are registered before the first
// dispatch — the barrel (../index.ts) imports them too, but a direct consumer of
// this module (a spec) must not depend on import order.
import '../anthropic';
import '../openai';
import '../google-gemini';

export const KODUS_PROVIDER_ID = 'kodus';

/** Env var carrying Kodus's platform key for each upstream account. Dedicated
 *  names on purpose — never the generic `API_ANTHROPIC_API_KEY` & co., so a
 *  self-hosted install's own keys can never be routed as "Kodus credits". */
export const KODUS_UPSTREAM_KEY_ENV: Record<KodusUpstream, string> = {
    fireworks: 'API_KODUS_PROVIDER_FIREWORKS_API_KEY',
    anthropic: 'API_KODUS_PROVIDER_ANTHROPIC_API_KEY',
    openai: 'API_KODUS_PROVIDER_OPENAI_API_KEY',
    google: 'API_KODUS_PROVIDER_GOOGLE_API_KEY',
};

/** Fireworks is spoken over `openai_compatible`, which has no default endpoint:
 *  the module pins it (same base the managed trial path uses). Never the org's
 *  own `baseURL` — the org has no say in where a Kodus-billed call goes. */
export const KODUS_FIREWORKS_BASE_URL_ENV = 'API_FIREWORKS_BASE_URL';
const FIREWORKS_DEFAULT_BASE_URL = 'https://api.fireworks.ai/inference/v1';

/** Endpoint an upstream is reached at, when the upstream module needs one. */
export function kodusUpstreamBaseURL(upstream: KodusUpstream): string | undefined {
    if (upstream !== 'fireworks') return undefined;
    return (
        (process.env[KODUS_FIREWORKS_BASE_URL_ENV] ?? '').trim() ||
        FIREWORKS_DEFAULT_BASE_URL
    );
}

/** The platform key for an upstream, or '' when the env var is unset. */
export function kodusUpstreamKey(upstream: KodusUpstream): string {
    return (process.env[KODUS_UPSTREAM_KEY_ENV[upstream]] ?? '').trim();
}

/** Which upstream accounts have a platform key configured in this process. */
export function configuredKodusUpstreams(): KodusUpstream[] {
    return (Object.keys(KODUS_UPSTREAMS) as KodusUpstream[]).filter(
        (u) => kodusUpstreamKey(u).length > 0,
    );
}

/**
 * Present a Kodus slot to its upstream module: the upstream's provider id, the
 * bare model id, and the PLATFORM key. Everything the org could not have set
 * on a keyless credential (baseURL, aws*, vertex*, openrouter*) is dropped so
 * the upstream builds against its canonical endpoint — or, for an upstream
 * without one (Fireworks over openai_compatible), the endpoint Kodus pins.
 */
function asUpstream(cfg: ProviderBuildConfig, ref: KodusModelRef): ProviderBuildConfig {
    const {
        baseURL: _baseURL,
        vertexLocation: _vertexLocation,
        awsBearerToken: _awsBearerToken,
        awsAccessKeyId: _awsAccessKeyId,
        awsSecretAccessKey: _awsSecretAccessKey,
        awsRegion: _awsRegion,
        awsSessionToken: _awsSessionToken,
        openrouterProviderOrder: _openrouterProviderOrder,
        openrouterAllowFallbacks: _openrouterAllowFallbacks,
        ...rest
    } = cfg;
    const baseURL = kodusUpstreamBaseURL(ref.upstream);
    return {
        ...rest,
        provider: ref.providerId as ProviderBuildConfig['provider'],
        model: ref.model,
        apiKey: kodusUpstreamKey(ref.upstream),
        ...(baseURL ? { baseURL } : {}),
    };
}

/** Resolve the upstream module for a Kodus model id, or null when the id is
 *  not routable (unknown prefix, or not in the closed catalog). */
function upstreamFor(
    modelId: string | undefined,
): { ref: KodusModelRef; module: ProviderModule } | null {
    const ref = splitKodusModelId(modelId);
    if (!ref || !isKodusCatalogModel(modelId!)) return null;
    if (!REGISTRY.has(ref.providerId)) return null;
    return { ref, module: REGISTRY.get(ref.providerId) };
}

/** What `capabilities()` answers for an id Kodus will not route: neither
 *  structured output nor native tool calling, so every task gate rejects it and
 *  the routing resolver degrades instead of dispatching an unbillable call. */
const NOT_ROUTABLE: ModelCapabilities = {
    supportsReasoning: false,
    structuredOutput: 'none',
    toolCalling: 'none',
    usageGranularity: 'output_only',
    streaming: false,
    promptCaching: false,
};

export const kodusModule: ProviderModule = {
    id: KODUS_PROVIDER_ID,
    label: 'Kodus',
    doc: 'https://docs.kodus.io/how_to_use/en/byok#kodus-credits',

    // Nothing to configure: no key, no endpoint. The schema still has to accept
    // `{}` (the registry conformance round-trips an empty settings object).
    settingsSchema: z.object({}).passthrough(),

    capabilities(model: string): ModelCapabilities {
        const up = upstreamFor(model);
        if (!up) return NOT_ROUTABLE;
        return up.module.capabilities(up.ref.model);
    },

    build(cfg: ProviderBuildConfig, opts?: ProviderBuildOptions): LanguageModel {
        const up = upstreamFor(cfg.model);
        if (!up) {
            throw new Error(
                `Kodus provider: "${cfg.model}" is not in the Kodus catalog — pick a listed model.`,
            );
        }
        const apiKey = kodusUpstreamKey(up.ref.upstream);
        if (!apiKey) {
            throw new Error(
                `Kodus provider: no platform key for upstream "${up.ref.upstream}" ` +
                    `(set ${KODUS_UPSTREAM_KEY_ENV[up.ref.upstream]}).`,
            );
        }
        // The upstream's canonical (or Kodus-pinned) endpoint only — never a
        // user-supplied fetch override either; the probe's redirect-refusing
        // fetch exists for user-typed endpoints, and this module has none.
        return up.module.build(asUpstream(cfg, up.ref), {
            structuredOutputs: opts?.structuredOutputs,
        });
    },

    reasoning(
        cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        const up = upstreamFor(cfg.model);
        if (!up || !up.module.reasoning) return {};
        return up.module.reasoning(asUpstream(cfg, up.ref), effort);
    },

    reasoningTraits(cfg: ProviderBuildConfig): ModelReasoningTraits {
        const up = upstreamFor(cfg.model);
        if (!up) return NON_REASONING_TRAITS;
        return up.module.reasoningTraits(asUpstream(cfg, up.ref));
    },

    // Native transport per upstream, so Anthropic gets its explicit ephemeral
    // breakpoint and OpenAI/Gemini keep their implicit caching — the exact
    // difference a gateway shim erases.
    systemCacheControl(
        cfg: ProviderBuildConfig,
    ): Record<string, unknown> | undefined {
        const up = upstreamFor(cfg.model);
        if (!up || !up.module.systemCacheControl) return undefined;
        return up.module.systemCacheControl(asUpstream(cfg, up.ref));
    },

    temperaturePolicy(cfg: ProviderBuildConfig): TemperaturePolicy {
        const up = upstreamFor(cfg.model);
        if (!up) return { kind: 'adjustable' };
        return up.module.temperaturePolicy(asUpstream(cfg, up.ref));
    },

    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    // No fields: the connect form collects nothing. `requiresApiKey` derives to
    // false from this (provider-ui-descriptor), which is what hides the key step.
    uiFields: [],

    providerOptionsNamespace: (_id, model) => {
        const up = upstreamFor(model);
        if (!up || !up.module.providerOptionsNamespace) return undefined;
        return up.module.providerOptionsNamespace(up.ref.providerId, up.ref.model);
    },
    providerOptionsNamespaceAliases: (_id) => [],
    reasoningOverrideExample: (_id, model) => {
        const up = upstreamFor(model);
        if (!up || !up.module.reasoningOverrideExample) return undefined;
        return up.module.reasoningOverrideExample(up.ref.providerId, up.ref.model);
    },
    modelListing: kodusModelListing,
};

registerProvider(kodusModule);
