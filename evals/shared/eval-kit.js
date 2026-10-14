// What every eval runner needs and should not write again (evals/AGENTS.md).
// Each piece here replaced a copy that drifted in one eval.
const path = require('path');

// LLM.run reports each model call's usage through this port; production
// registers a billing span there (libs/llm/llm-observability.ts). An eval
// registers this one and reads the total with tokensUsed(). The kody-rules eval
// reported 0 tokens until it did.
function countTokens() {
    const { setLlmObservability } = require(path.join(__dirname, '../../libs/llm/llm-observability.ts'));
    setLlmObservability({
        runAiSdkLLMInSpan: async ({ exec }) => {
            const result = await exec();
            const u = (result && result.usage) || {};
            const tok = tokensUsed();
            tok.in += u.inputTokens ?? 0;
            tok.out += u.outputTokens ?? 0;
            tok.cacheRead += u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0;
            return result;
        },
    });
}

// The running total, shared with agent-run usage spans an eval may also count.
function tokensUsed() {
    global.__EVAL_TOK = global.__EVAL_TOK || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    return global.__EVAL_TOK;
}

module.exports = { countTokens, tokensUsed };
