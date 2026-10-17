import { execFileSync } from 'child_process';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { effortOf } = require('./eval-kit');

// countTokens() registers the LLM port the engine reports each model call
// through; it runs in plain node, like every eval, so the spec does too.
const script = `
const path = require('path');
const { countTokens, tokensUsed } = require('./evals/shared/eval-kit');
// The provider, stubbed: the watcher sees each request body and changes nothing.
globalThis.fetch = async () => new Response('{}');
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
    // A request inside a task: its body's effort is recorded under the task.
    await port.runAiSdkLLMInSpan({ spanName: 'v', runName: 'code-review-generalist-verify', exec: async () => {
        await fetch('http://provider/v1', { method: 'POST', body: JSON.stringify({ model: 'm', reasoning_effort: 'low', messages: [{ role: 'user', content: 'effort' }] }) });
        return { usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    // Outside any task (a judge's own call): not recorded.
    await fetch('http://judge/v1', { method: 'POST', body: JSON.stringify({ model: 'j', reasoning_effort: 'high' }) });
    // Exit once the JSON is flushed: the engine can leave handles open.
    process.stdout.write(JSON.stringify(tokensUsed()), () => process.exit(0));
})();
`;

describe('evals/shared/eval-kit countTokens', () => {
    it('counts each answered call like billing: tokens with cache, its time, and nothing for a call never answered', () => {
        const out = execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
        const tok = JSON.parse(out);
        expect(tok).toMatchObject({ in: 151, out: 16, cacheRead: 40, cacheWrite: 5, calls: 3 });
        expect(tok.callMs).toHaveLength(3);
        expect(tok.callMs[0]).toBeGreaterThanOrEqual(25);
        expect(tok.ms).toBe(tok.callMs[0] + tok.callMs[1] + tok.callMs[2]);
        expect(tok.efforts).toEqual({ 'code-review-generalist-verify': ['low'] });
    });

    // The shapes production's reasoning-options.ts sends (probed per provider).
    it('reads the effort a request carried, whatever the provider calls it', () => {
        expect(effortOf({ model: 'm', thinking: { type: 'enabled' }, reasoning_effort: 'low' })).toBe('low');
        expect(effortOf({ model: 'm', thinking: { type: 'disabled' } })).toBe('off');
        expect(effortOf({ model: 'm', reasoning: { effort: 'medium' } })).toBe('medium');
        expect(effortOf({ model: 'm', thinking: { type: 'adaptive' }, output_config: { effort: 'low' } })).toBe('low');
        expect(effortOf({ model: 'm', thinking: { type: 'enabled', budget_tokens: 2048 } })).toBe('thinking 2048 tokens');
        expect(effortOf({ model: 'm', messages: [{ effort: 'high' }] })).toBe('not sent');
        expect(effortOf({ model: 'm' })).toBe('not sent');
    });
});
