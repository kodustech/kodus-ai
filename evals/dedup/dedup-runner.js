// Production's dedup on a list of findings: AgentReviewStage.dedupSuggestionStreams
// (agent-review.stage.ts) — Kody Rule findings merged by rule, the others by the
// dedup model behind its merge guard (lexical overlap, the platform's embedder,
// the tiebreak), then the cross-stream pass — on a stage built as the review
// builds it, over the team's default config with the model routed as an org's
// (evals/shared/review-stage.js teamContext). A failed pass keeps every
// finding, as in production.
// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
const { TIER0 } = require('../shared/tier0-models');

// The model a cloud org without BYOK reviews with (the managed default).
const DEFAULT_MODEL = 'deepseek-v4-flash@fireworks';

// Every model routes as an org's (evals/shared/model-route.js).
const DEDUP_MODELS = TIER0;

/**
 * @param {Array} suggestions
 * @param {string} modelKey   tier0-models id
 */
async function runDedup(suggestions, modelKey = DEFAULT_MODEL) {
    if (suggestions.length <= 1) {
        return { kept: suggestions.map((_, i) => i), dropped: [], noOp: false, trace: { status: 'skipped' } };
    }
    if (!DEDUP_MODELS[modelKey]) {
        throw new Error(`unknown dedup model '${modelKey}' (have: ${Object.keys(DEDUP_MODELS).join(', ')})`);
    }
    process.env.RECALL_MODEL = modelKey;
    const { internals } = require('../investigation/agent-provider');
    const { teamContext, buildAgentReviewStage } = require('../shared/review-stage');
    const route = internals.resolveRoute({ provider: 'tier0', model: modelKey });
    const permissionService = internals.evalPermissionService(route.storedConfig);
    const { context, codeManagement } = await teamContext({ route, permissionService });
    const stage = buildAgentReviewStage({ permissionService, codeManagement });
    // `evalIndex` maps what comes out back to what went in (the stage copies
    // findings, fields kept).
    const input = suggestions.map((s, k) => ({ ...s, evalIndex: k }));
    const { deduped, dedupTrace } = await stage.dedupSuggestionStreams(input, 1, context, undefined);
    const kept = [...new Set(deduped.map((s) => s.evalIndex))].sort((a, b) => a - b);
    const dropped = input.map((_, k) => k).filter((k) => !kept.includes(k)).map((idx) => ({ idx }));
    // A pass that failed or returned nothing usable kept everything: flagged,
    // because a model that often no-ops here is a poor dedup model however
    // safe keeping all is.
    return { kept, dropped, noOp: dedupTrace.status === 'failed-keep-all' || dedupTrace.status === 'empty-keep-all', trace: dedupTrace };
}

module.exports = { runDedup, DEDUP_MODELS, DEFAULT_MODEL };
