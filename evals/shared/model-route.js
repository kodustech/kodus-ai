// How an eval reaches its model the way an org does: a stored BYOK config, read
// by production's PermissionValidationService and routed by resolveTaskSlot,
// for every model, DeepSeek included, so every model is measured on the same
// path an org that picks its model takes. The managed default (an org with no
// model config: Kodus's own DeepSeek and key) is a contract test, not an eval:
// the `kodus-managed` entry of tier0-models.js routes it with no stored config
// (evals/wiring-smoke.js `managed-route`). Model ids and keys come from
// evals/shared/tier0-models.js only. Shared by every eval that runs the review
// stage (evals/shared/review-stage.js).
// The route reads production's TypeScript (libs/llm), so the hooks load here,
// whoever requires this first.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const path = require('path');

// ── The model, routed as production routes it ──────────────────────────────
// Production hands the finder no model. execute() routes the codeReview task to
// a slot (model-factory.ts resolveReviewAgentModel → permissionValidationService
// .resolveTaskSlot), and LLM.run builds the model from that slot, or from the
// managed default when there is none (AiSdkAgentRunner's call to LLM.run).
//
// So the eval routes the way a cloud org with BYOK does (tier0-models.js
// applyPlatformEnv sets the platform's own keys, and no self-hosted env model):
// a stored BYOK config (version 2) holding the model, read by production's
// getBYOKConfig (permissionValidation.service.ts) and routed by
// resolveTaskSlot, like a customer's BYOK model and its effort. The two routes
// send different requests for the same DeepSeek (2026-10-17: the BYOK route
// sends `thinking` on every call and `reasoning_effort: high` on structured
// ones; the managed route sends neither), so the evals measure one route: BYOK.
// The model's key is in the stored config, never in API_OPEN_AI_API_KEY: that
// variable is the platform's OpenAI key, which the dedup's embedder reads.
// The org's stored config is the one thing the eval supplies (the
// organization-parameters read); the routing and the model are production's.

// A UUID: getBYOKConfig reads an org's config only for one
// (permissionValidation.service.ts).
const EVAL_ORG = {
    organizationId: '00000000-0000-4000-8000-00000000e7a1',
    teamId: 'eval-team',
};

// Provider ids of evals/shared/tier0-models.js →
// BYOKProvider (libs/llm/model-providers.ts).
const BYOK_PROVIDER = {
    google: 'google_gemini',
    openai: 'openai',
    anthropic: 'anthropic',
    openai_compatible: 'openai_compatible',
    'openai-compatible': 'openai_compatible',
    openrouter: 'open_router',
};

/** A model the eval cannot run the way production would: not measured. */
class NotAProductionRoute extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotAProductionRoute';
    }
}

function storedByokConfig({ provider, model, apiKey, baseURL, reasoningEffort, openrouterProviderOrder }) {
    const byokProvider = openrouterProviderOrder?.length ? 'open_router' : BYOK_PROVIDER[provider];
    if (!byokProvider) {
        throw new NotAProductionRoute(`provider '${provider}' has no BYOK route in production`);
    }
    const { encrypt } = require('../../libs/common/utils/crypto.ts');
    return {
        version: 2,
        credentials: [
            {
                id: 'eval-credential',
                provider: byokProvider,
                apiKey: encrypt(apiKey),
                // Where resolveModelSlot reads them (resolve-model-slot.ts).
                settings: {
                    ...(baseURL ? { baseURL } : {}),
                    ...(openrouterProviderOrder?.length
                        ? { openrouterProviderOrder, openrouterAllowFallbacks: false }
                        : {}),
                },
            },
        ],
        models: [
            {
                id: 'eval-model',
                credentialId: 'eval-credential',
                model,
                ...(reasoningEffort ? { reasoningEffort } : {}),
            },
        ],
        routing: { defaultModelId: 'eval-model' },
    };
}

/**
 * A stored BYOK config (version 2) holding several models, one credential each,
 * with `routing` as the org would save it. Each model: { id, provider, model,
 * apiKey, baseURL?, reasoningEffort?, openrouterProviderOrder? }.
 */
function storedByokConfigOf(models, routing) {
    const { encrypt } = require('../../libs/common/utils/crypto.ts');
    return {
        version: 2,
        credentials: models.map((m) => {
            const provider = m.openrouterProviderOrder?.length ? 'open_router' : BYOK_PROVIDER[m.provider];
            if (!provider) throw new NotAProductionRoute(`provider '${m.provider}' has no BYOK route in production`);
            return {
                id: `${m.id}-credential`,
                provider,
                apiKey: encrypt(m.apiKey),
                settings: {
                    ...(m.baseURL ? { baseURL: m.baseURL } : {}),
                    ...(m.openrouterProviderOrder?.length
                        ? { openrouterProviderOrder: m.openrouterProviderOrder, openrouterAllowFallbacks: false }
                        : {}),
                },
            };
        }),
        models: models.map((m) => ({
            id: m.id,
            credentialId: `${m.id}-credential`,
            model: m.model,
            ...(m.reasoningEffort ? { reasoningEffort: m.reasoningEffort } : {}),
        })),
        routing: routing || { defaultModelId: models[0].id },
    };
}

/** A stored-config model entry for a tier-0 model id, its key from the env. */
function tier0ModelEntry(id, modelId) {
    const { TIER0 } = require('./tier0-models');
    const spec = TIER0[modelId];
    if (!spec) throw new Error(`unknown model ${modelId} (evals/shared/tier0-models.js)`);
    const apiKey = (spec.keyEnvs || []).map((name) => process.env[name]).find(Boolean);
    if (!apiKey) throw new Error(`no key for ${modelId} (${(spec.keyEnvs || []).join(', ') || 'none known'})`);
    return { id, provider: spec.provider, model: spec.doModel || modelId, apiKey, baseURL: spec.baseURL, openrouterProviderOrder: spec.openrouterProviderOrder };
}

/**
 * How this run reaches its model: `{ storedConfig, route, modelId, reasoningEffort }`,
 * storedConfig null on the managed route. Throws NotAProductionRoute for a
 * model production cannot run.
 */
function resolveRoute(config) {
    const effort = process.env.RECALL_REASONING_EFFORT || null;
    if (config.provider === 'tier0') {
        const modelId = process.env.RECALL_MODEL || config.model;
        const { applyPlatformEnv, TIER0 } = require('./tier0-models');
        const spec = TIER0[modelId];
        if (spec && spec.provider === 'codex_subscription') {
            throw new NotAProductionRoute(
                `${modelId} runs on a ChatGPT subscription, which production has no route for ` +
                    '(libs/llm/codex-subscription-model.ts is used only by evals): the finder would run another model',
            );
        }
        applyPlatformEnv();
        if (!spec) throw new Error(`unknown tier-0 model '${modelId}'`);
        // `kodus-managed`: an org with no model config, which gets Kodus's default
        // model on Kodus's key (libs/llm/managed-slot.ts). No stored config, no effort.
        if (spec.managed) {
            if (effort) throw new NotAProductionRoute(`${modelId} has no model config, so no reasoning effort to set`);
            if (!process.env.API_FIREWORKS_API_KEY) throw new Error(`no API key for the managed route — set one of ${spec.keyEnvs.join('/')}`);
            return { storedConfig: null, route: 'managed', modelId, reasoningEffort: null };
        }
        const key = spec.keyEnvs.map((name) => process.env[name]).find(Boolean);
        if (!key) throw new Error(`no API key for ${modelId} — set one of ${spec.keyEnvs.join('/') || 'none known'}`);
        return {
            storedConfig: storedByokConfig({
                provider: spec.provider,
                model: spec.doModel || modelId,
                apiKey: key,
                baseURL: spec.baseURL,
                reasoningEffort: effort,
                openrouterProviderOrder: spec.openrouterProviderOrder,
            }),
            route: 'byok',
            modelId,
            reasoningEffort: effort,
        };
    }

    // Model ids and keys come only from evals/shared/tier0-models.js.
    throw new NotAProductionRoute(`model '${config.model || 'unset'}' is not a tier-0 model: add it to evals/shared/tier0-models.js`);
}

/**
 * The org's route for a tier-0 model, for a runner about to measure: an
 * unknown model, a missing key or a route production lacks is "not measured"
 * (exit 2), never a quality result.
 */
function orgRouteOrExit(modelId) {
    try {
        return resolveRoute({ provider: 'tier0', model: modelId });
    } catch (error) {
        console.error(`not measured: ${error.message}`);
        process.exit(2);
    }
}

// The permission service production routes through, over the eval org's stored
// config: only the organization-parameters read is the eval's.
function evalPermissionService(storedConfig) {
    const { PermissionValidationService } = require(
        path.join(__dirname, '../../libs/ee/shared/services/permissionValidation.service.ts'),
    );
    const { OrganizationParametersKey } = require(
        path.join(__dirname, '../../libs/core/domain/enums/organization-parameters-key.enum.ts'),
    );
    // The org's licence, as the licence service answers for a paid org: valid,
    // so its resources are not limited (shouldLimitResources).
    const licenseService = {
        validateOrganizationLicense: async () => ({ valid: true, subscriptionStatus: 'licensed-self-hosted', planType: 'teams' }),
    };
    return new PermissionValidationService(licenseService, {
        findByKey: async (key) =>
            key === OrganizationParametersKey.BYOK_CONFIG && storedConfig ? { configValue: storedConfig } : null,
    });
}

module.exports = { resolveRoute, orgRouteOrExit, evalPermissionService, storedByokConfig, storedByokConfigOf, tier0ModelEntry, NotAProductionRoute, EVAL_ORG };
