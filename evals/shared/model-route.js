// How an eval reaches its model the way an org does: the env/managed route by
// default, a stored BYOK config read by production's PermissionValidationService
// and routed by resolveTaskSlot when the run asks for a reasoning effort or names
// its own provider. Shared by every eval that runs the review stage
// (evals/shared/review-stage.js).
const path = require('path');

function defaultApiKeyEnv(provider) {
    switch (provider) {
        case 'openai':
            return 'API_OPEN_AI_API_KEY';
        case 'openai-compatible':
            return 'API_OPEN_AI_API_KEY';
        case 'anthropic':
            return 'API_ANTHROPIC_API_KEY';
        case 'openrouter':
            return 'API_OPENROUTER_KEY';
        case 'google':
        default:
            return 'API_GOOGLE_AI_API_KEY';
    }
}

// ── The model, routed as production routes it ──────────────────────────────
// Production hands the finder no model. execute() routes the codeReview task to
// a slot (resolveReviewAgentModel → permissionValidationService.resolveTaskSlot,
// model-factory.ts:61-110), and LLM.run builds the model from that slot, or from
// the env/managed default when there is none (ai-sdk-agent-runner.ts:245-246).
// The loop ignores an AgentLoopInput `model` (review-agent.contract.ts:360-362),
// so the model this eval used to build never ran: RECALL_REASONING_EFFORT never
// reached the finder, and an `@sub` model ran the managed default.
//
// So the eval routes the way an org does:
//   - by default no stored config: the env/managed route trial orgs take, with
//     applyModelEnv pointing it at the eval's model;
//   - with RECALL_REASONING_EFFORT, or a promptfoo config that names its own
//     provider: a stored BYOK config (version 2) holding that model, read by
//     production's getBYOKConfig (permissionValidation.service.ts:1170-1186) and
//     routed by resolveTaskSlot, like a customer's BYOK model and its effort.
// The org's stored config is the one thing the eval supplies (the
// organization-parameters read); the routing and the model are production's.

// A UUID: getBYOKConfig reads an org's config only for one
// (permissionValidation.service.ts:1173-1177).
const EVAL_ORG = {
    organizationId: '00000000-0000-4000-8000-00000000e7a1',
    teamId: 'eval-team',
};

// Provider ids of evals/shared/tier0-models.js and the promptfoo configs →
// BYOKProvider (libs/llm/model-providers.ts:15-35).
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
                // Where resolveModelSlot reads them (resolve-model-slot.ts:86-99).
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
 * How this run reaches its model: `{ storedConfig, route, modelId, reasoningEffort }`,
 * storedConfig null on the managed route. Throws NotAProductionRoute for a
 * model production cannot run.
 */
function resolveRoute(config) {
    const effort = process.env.RECALL_REASONING_EFFORT || null;
    if (config.provider === 'tier0') {
        const modelId = process.env.RECALL_MODEL || config.model;
        const { applyModelEnv, TIER0 } = require('./tier0-models');
        const spec = TIER0[modelId];
        if (spec && spec.provider === 'codex_subscription') {
            throw new NotAProductionRoute(
                `${modelId} runs on a ChatGPT subscription, which production has no route for ` +
                    '(libs/llm/codex-subscription-model.ts is used only by evals): the finder would run another model',
            );
        }
        // The env the managed route reads, and what the run's other callers
        // (the judge excepted) fall back to.
        applyModelEnv(modelId);
        if (!effort) return { storedConfig: null, route: 'managed', modelId, reasoningEffort: null };
        const key = (spec?.keyEnvs || []).map((name) => process.env[name]).find(Boolean);
        if (!key) {
            throw new Error(
                `RECALL_REASONING_EFFORT routes ${modelId} through a BYOK config, which needs its key (${(spec?.keyEnvs || []).join(', ') || 'none known'})`,
            );
        }
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

    // A promptfoo config naming its own provider (promptfoo*.yaml). Env
    // overrides so ANY model runs from one yaml (no per-provider config):
    //   RECALL_MODEL, RECALL_PROVIDER, RECALL_BASEURL, RECALL_APIKEY_ENV.
    if (process.env.RECALL_PROVIDER || process.env.RECALL_BASEURL) {
        config = {
            ...config,
            ...(process.env.RECALL_PROVIDER ? { provider: process.env.RECALL_PROVIDER } : {}),
            ...(process.env.RECALL_BASEURL ? { baseURL: process.env.RECALL_BASEURL } : {}),
        };
    }
    const provider = config.provider || 'google';
    const model = process.env.RECALL_MODEL || config.model;
    const apiKeyEnv = process.env.RECALL_APIKEY_ENV || config.apiKeyEnv || defaultApiKeyEnv(provider);
    const apiKey = config.apiKey || process.env[apiKeyEnv];
    if (!model) throw new Error('Missing provider config.model');
    if (!apiKey) throw new Error(`Missing API key for ${provider} in ${apiKeyEnv}`);
    return {
        storedConfig: storedByokConfig({
            provider,
            model,
            apiKey,
            baseURL: config.baseURL || (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined),
            reasoningEffort: effort,
            openrouterProviderOrder: Array.isArray(config.providerOrder) ? config.providerOrder.filter(Boolean) : undefined,
        }),
        route: 'byok',
        modelId: model,
        reasoningEffort: effort,
    };
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

module.exports = { resolveRoute, evalPermissionService, storedByokConfig, NotAProductionRoute, EVAL_ORG };
