#!/usr/bin/env node
// funnel/dedup: the frozen candidates that survived verify (snapshot.js)
// through the production dedup, `AgentReviewStage.deduplicateSuggestions`
// (agent-review.stage.ts) on the eval's model. A known bug is lost when every
// finding that matches it is merged away. The method is private and reads only
// the stage's logger and name, so it runs on the stage's prototype, unchanged.
const { main } = require('../stage-run');
const { withCallErrors } = require('../../shared/eval-kit');

main({
    id: 'dedup',
    usesModel: true,
    apply: async (input) => {
        const { AgentReviewStage } = require('../../../libs/code-review/pipeline/stages/agent-review.stage.ts');
        const { createLogger } = require('../../../libs/core/log/logger.ts');
        const stage = Object.create(AgentReviewStage.prototype);
        stage.logger = createLogger('AgentReviewStage');
        stage.stageName = 'AgentReviewStage';
        const suggestions = input.map((c) => ({ ...c.finding }));
        const { classifyLLMError, LlmErrorCategory } = require('../../../libs/llm/error-classifier.ts');
        const { result, errors } = await withCallErrors(() => stage.deduplicateSuggestions(suggestions, 1, undefined, { organizationId: 'funnel-eval' }));
        // A failed dedup keeps every finding, in production too, and is scored
        // as such; only a provider refusal leaves the case unmeasured.
        const refused = errors.find((e) => ['AUTH_INVALID', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'MODEL_NOT_FOUND', 'MODEL_ACCESS_DENIED'].map((c) => LlmErrorCategory[c]).includes(classifyLLMError(e).category));
        if (refused) throw new Error(`dedup call refused: ${String(refused.message || refused).slice(0, 160)}`);
        const out = result.suggestions;
        const index = new Map(suggestions.map((s, k) => [s, k]));
        return out.map((s) => index.get(s)).filter((k) => k !== undefined);
    },
});
