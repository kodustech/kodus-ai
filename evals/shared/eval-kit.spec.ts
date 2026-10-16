import { execFileSync } from 'child_process';
import * as path from 'path';

// countTokens() registers the LLM port the engine reports each model call
// through; it runs in plain node, like every eval, so the spec does too.
const script = `
const path = require('path');
const { countTokens, tokensUsed } = require('./evals/shared/eval-kit');
countTokens();
const { getLlmObservability } = require(path.resolve('libs/llm/llm-observability.ts'));
const port = getLlmObservability();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    await port.runAiSdkLLMInSpan({ spanName: 'a', exec: async () => { await wait(30); return { usage: { inputTokens: 100, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 5 } } }; } });
    // Answered, then rejected by the parse: billed, so counted.
    const billed = Object.assign(new Error('No object generated'), { usage: { inputTokens: 50, outputTokens: 5 } });
    await port.runAiSdkLLMInSpan({ spanName: 'b', exec: async () => { throw billed; } }).catch(() => {});
    // Never answered: not counted.
    await port.runAiSdkLLMInSpan({ spanName: 'c', exec: async () => { throw new Error('ETIMEDOUT'); } }).catch(() => {});
    // Exit once the JSON is flushed: the engine can leave handles open.
    process.stdout.write(JSON.stringify(tokensUsed()), () => process.exit(0));
})();
`;

describe('evals/shared/eval-kit countTokens', () => {
    it('counts each answered call like billing: tokens with cache, its time, and nothing for a call never answered', () => {
        const out = execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
        const tok = JSON.parse(out);
        expect(tok).toMatchObject({ in: 150, out: 15, cacheRead: 40, cacheWrite: 5, calls: 2 });
        expect(tok.callMs).toHaveLength(2);
        expect(tok.callMs[0]).toBeGreaterThanOrEqual(25);
        expect(tok.ms).toBe(tok.callMs[0] + tok.callMs[1]);
    });
});
