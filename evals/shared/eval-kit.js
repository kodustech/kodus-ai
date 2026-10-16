// What every eval runner needs and should not write again (evals/AGENTS.md).
// Each piece here replaced a copy that drifted in one eval.
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');

const callScope = new AsyncLocalStorage();

// Load the engine's TypeScript from plain node: esbuild, not ts-node, because
// agent-loop.ts places value imports mid-file and ts-node leaves them
// un-hoisted ("Cannot access 'llm_1' before initialization"). The same hook the
// kody-rules runner registers; a no-op when one is already registered.
function registerTs() {
    if (require.extensions['.ts']) return;
    const esbuild = require('esbuild');
    require.extensions['.ts'] = function compileTs(module, filename) {
        const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
            loader: 'ts',
            format: 'cjs',
            target: 'es2021',
            sourcefile: filename,
            tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
        });
        module._compile(code, filename);
    };
    require('tsconfig-paths/register');
}

// LLM.run reports each model call's usage through this port; production
// registers a billing span there (libs/llm/llm-observability.ts). An eval
// registers this one and reads the total with tokensUsed(). The kody-rules eval
// reported 0 tokens until it did. An agent loop is one call: its usage is the
// sum of its steps (ai@7 `usage`).
function countTokens() {
    registerTs();
    const { setLlmObservability } = require(path.join(__dirname, '../../libs/llm/llm-observability.ts'));
    const { readAiSdkUsage, readAiSdkUsageFromError } = require(path.join(__dirname, '../../libs/llm/ai-sdk-usage.ts'));
    setLlmObservability({
        runAiSdkLLMInSpan: async ({ exec }) => {
            const startedAt = Date.now();
            let result;
            try {
                result = await exec();
            } catch (error) {
                failedCalls().push(error);
                callScope.getStore()?.push(error);
                // A call the provider answered and the parse then rejected was
                // still billed, as production records it; one that never got an
                // answer (timeout, refusal) carries no usage and is not counted.
                const billed = readAiSdkUsageFromError(error);
                if (billed) addCall(billed.usage, Date.now() - startedAt);
                throw error;
            }
            addCall(readAiSdkUsage(result && result.usage), Date.now() - startedAt);
            return result;
        },
    });
}

// The running total of what the model calls cost, shared with agent-run usage
// spans an eval may also count. Every field sums or concatenates, so two runs
// pool (evals/shared/nightly-verdict.js):
//   in, out, cacheRead, cacheWrite  tokens, read like billing (libs/llm/ai-sdk-usage.ts);
//                                   `in` includes the cached ones
//   calls, ms                       the calls the provider answered, and their time
//   callMs                          each of those calls' time, for percentiles
function tokensUsed() {
    global.__EVAL_TOK = global.__EVAL_TOK || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0, ms: 0, callMs: [] };
    return global.__EVAL_TOK;
}

// One answered call: its usage (libs/llm/ai-sdk-usage.ts AiSdkUsage) and time.
function addCall(usage, ms) {
    const tok = tokensUsed();
    tok.in += usage?.inputTokens ?? 0;
    tok.out += usage?.outputTokens ?? 0;
    tok.cacheRead += usage?.cacheReadTokens ?? 0;
    tok.cacheWrite += usage?.cacheWriteTokens ?? 0;
    tok.calls += 1;
    tok.ms += Math.round(ms);
    tok.callMs.push(Math.round(ms));
}

// The errors of the model calls that failed since countTokens(), in order. An
// engine path that swallows a failed call (prose recovery returns []) hides a
// provider refusal behind a miss; with these, the eval can tell them apart.
function failedCalls() {
    global.__EVAL_FAILED_CALLS = global.__EVAL_FAILED_CALLS || [];
    return global.__EVAL_FAILED_CALLS;
}

// Runs fn and returns what it returned with the errors of the model calls it
// made, and only those: cases running at once do not see each other's.
async function withCallErrors(fn) {
    const errors = [];
    const result = await callScope.run(errors, fn);
    return { result, errors };
}

module.exports = { registerTs, countTokens, tokensUsed, addCall, failedCalls, withCallErrors };
