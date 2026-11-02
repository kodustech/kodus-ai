// Shared LLM-model construction for evals.
//
// Every model-backed eval builds its model the SAME way production does — the
// env / self-hosted "managed" path (applyModelEnv sets API_LLM_PROVIDER_MODEL +
// key, and buildModelFromSlot(undefined, ...) resolves it). Wrapping it here
// gives ONE choke point so the next LLM-build refactor touches this file, not
// every eval. This is glue only: it changes HOW an eval builds the model, never
// what the eval measures.
//
// Behavior-preserving replacement for the removed:
//   byokToVercelModel(undefined, 'main', opts[, default])
//   getInternalModel(undefined, opts)
// both of which resolved the same env-default managed slot.
const { buildModelFromSlot } = require('../../libs/llm/byok-to-vercel.ts');

/**
 * Build the eval's LanguageModel from the env-configured managed slot.
 * @param {object} [options]              ByokModelOptions (e.g. { structuredOutputs: true })
 * @param {string} [defaultModelOverride] model id when the env has none
 */
function buildEvalModel(options = {}, defaultModelOverride) {
    return buildModelFromSlot(undefined, options, defaultModelOverride);
}

module.exports = { buildEvalModel };
