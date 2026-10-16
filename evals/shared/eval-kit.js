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
// reported 0 tokens until it did.
function countTokens() {
    registerTs();
    const { setLlmObservability } = require(path.join(__dirname, '../../libs/llm/llm-observability.ts'));
    setLlmObservability({
        runAiSdkLLMInSpan: async ({ exec }) => {
            let result;
            try {
                result = await exec();
            } catch (error) {
                failedCalls().push(error);
                callScope.getStore()?.push(error);
                throw error;
            }
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

module.exports = { registerTs, countTokens, tokensUsed, failedCalls, withCallErrors };
