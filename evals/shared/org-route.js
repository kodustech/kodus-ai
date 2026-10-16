// An org as production stores it, for evals that reach a model the way an org's
// review does: the org ids, its stored BYOK config (data), and production's
// PermissionValidationService reading that config from an in-memory
// organization-parameters store. The routing (getBYOKConfig → resolveTaskSlot)
// is production's; only the storage is the eval's.
const path = require('path');

// A UUID: getBYOKConfig reads an org's config only for one.
const EVAL_ORG = {
    organizationId: '00000000-0000-4000-8000-00000000e7a1',
    teamId: '00000000-0000-4000-8000-00000000e7a2',
};

// Provider ids of evals/shared/tier0-models.js → the BYOKProvider enum
// (libs/llm/model-providers.ts).
const BYOK_PROVIDER = {
    google: 'google_gemini',
    openai: 'openai',
    anthropic: 'anthropic',
    openai_compatible: 'openai_compatible',
    'openai-compatible': 'openai_compatible',
    openrouter: 'open_router',
};

/**
 * A stored BYOK config (version 2) holding `models`, one credential each, with
 * `routing` as the org would save it. Each model: { id, provider, model, apiKey,
 * baseURL?, reasoningEffort?, openrouterProviderOrder? }.
 */
function storedByokConfig(models, routing) {
    const { encrypt } = require(path.join(__dirname, '../../libs/common/utils/crypto.ts'));
    return {
        version: 2,
        credentials: models.map((m) => {
            const provider = m.openrouterProviderOrder?.length ? 'open_router' : BYOK_PROVIDER[m.provider];
            if (!provider) throw new Error(`provider '${m.provider}' has no BYOK route in production`);
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

/** A stored-config model entry for a tier0 model id, with its key from the env. */
function tier0ModelEntry(id, modelId) {
    const { TIER0 } = require('./tier0-models');
    const spec = TIER0[modelId];
    if (!spec) throw new Error(`unknown model ${modelId} (evals/shared/tier0-models.js)`);
    const apiKey = (spec.keyEnvs || []).map((name) => process.env[name]).find(Boolean);
    if (!apiKey) throw new Error(`no key for ${modelId} (${(spec.keyEnvs || []).join(', ') || 'none known'})`);
    return {
        id,
        provider: spec.provider,
        model: spec.doModel || modelId,
        apiKey,
        baseURL: spec.baseURL,
        openrouterProviderOrder: spec.openrouterProviderOrder,
    };
}

/** Production's PermissionValidationService over an org whose stored BYOK config is `storedConfig` (null: none). */
function evalPermissionService(storedConfig) {
    const { PermissionValidationService } = require(path.join(__dirname, '../../libs/ee/shared/services/permissionValidation.service.ts'));
    const { OrganizationParametersKey } = require(path.join(__dirname, '../../libs/core/domain/enums/organization-parameters-key.enum.ts'));
    return new PermissionValidationService(undefined, {
        findByKey: async (key) => (key === OrganizationParametersKey.BYOK_CONFIG && storedConfig ? { configValue: storedConfig } : null),
    });
}

module.exports = { EVAL_ORG, BYOK_PROVIDER, storedByokConfig, tier0ModelEntry, evalPermissionService };
