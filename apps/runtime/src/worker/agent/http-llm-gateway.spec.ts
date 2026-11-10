import { devSealKey } from '../../testing/dev-seal-key';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import { HttpLlmGateway, type FetchLike } from './http-llm-gateway';
import { LlmBudgetExceededError, LlmRequest, LlmUnavailableError } from './llm-gateway';

const TOKEN = 'krt1.fake-run-token.sig';
const secrets = new SealedSecretOpener(devSealKey());
// The Run token arrives sealed for its Run; the gateway opens it for the call only.
const req: LlmRequest = { runId: 'run-1', organizationId: 'org-1', runToken: secrets.seal(TOKEN, 'run-1'), task: 'runtime.plan', messages: [{ role: 'user', content: 'explore' }] };

const fakeFetch = (status: number, body: unknown) => {
    const calls: any[] = [];
    const fn: FetchLike = async (url, init) => {
        calls.push({ url, init });
        return { status, ok: status >= 200 && status < 300, json: async () => body };
    };
    return { fn, calls };
};

describe('HttpLlmGateway', () => {
    it('posts the turn with the Run token and maps text + usage', async () => {
        const f = fakeFetch(200, { text: 'plan', usage: { inputTokens: 10, outputTokens: 5 }, budget: { remaining: 85 } });
        const metrics = { recordLlmBudget: jest.fn() } as any;
        const res = await new HttpLlmGateway('http://api.test/', { secrets, fetch: f.fn, metrics, maxOutputTokens: 900 }).complete({ ...req, task: 'runtime.intent' });

        expect(res).toEqual({ text: 'plan', usage: { inputTokens: 10, outputTokens: 5 } });
        expect(f.calls[0].url).toBe('http://api.test/internal/runtime/llm');
        expect(f.calls[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(JSON.parse(f.calls[0].init.body)).toEqual({ runId: 'run-1', task: 'runtime.intent', messages: req.messages, maxOutputTokens: 900 });
        expect(metrics.recordLlmBudget.mock.calls[0][0]).toBeCloseTo(0.15);
        expect(metrics.recordLlmBudget.mock.calls[0][1]).toEqual({ orgId: 'org-1', state: 'ok' });
    });

    it('maps 429 llm_budget_exceeded to LlmBudgetExceededError', async () => {
        const f = fakeFetch(429, { code: 'llm_budget_exceeded', scope: 'run' });
        await expect(new HttpLlmGateway('http://api.test', { secrets, fetch: f.fn }).complete(req)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    });

    it.each([400, 401, 403, 429, 502, 503])('maps %s to LlmUnavailableError without the token', async (status) => {
        const f = fakeFetch(status, { message: 'nope' });
        const err = await new HttpLlmGateway('http://api.test', { secrets, fetch: f.fn }).complete(req).catch((e) => e);
        expect(err).toBeInstanceOf(LlmUnavailableError);
        expect(err.message).toContain(String(status));
        expect(err.message).not.toContain(TOKEN);
    });

    it('maps a network failure to LlmUnavailableError without the token', async () => {
        const fn: FetchLike = async () => {
            throw new TypeError(`fetch failed for ${TOKEN}`);
        };
        const err = await new HttpLlmGateway('http://api.test', { secrets, fetch: fn }).complete(req).catch((e) => e);
        expect(err).toBeInstanceOf(LlmUnavailableError);
        expect(err.message).not.toContain(TOKEN);
    });

    it('refuses a turn without a Run token before calling out', async () => {
        const f = fakeFetch(200, {});
        await expect(new HttpLlmGateway('http://api.test', { secrets, fetch: f.fn }).complete({ ...req, runToken: '' })).rejects.toBeInstanceOf(LlmUnavailableError);
        expect(f.calls).toHaveLength(0);
    });
    it('refuses a token sealed for another Run, or not sealed, without calling out', async () => {
        const f = fakeFetch(200, { text: 'plan', usage: { inputTokens: 1, outputTokens: 1 } });
        const gw = new HttpLlmGateway('http://api.test', { secrets, fetch: f.fn });
        await expect(gw.complete({ ...req, runToken: secrets.seal(TOKEN, 'run-2') })).rejects.toBeInstanceOf(LlmUnavailableError);
        await expect(gw.complete({ ...req, runToken: TOKEN })).rejects.toBeInstanceOf(LlmUnavailableError);
        expect(f.calls).toHaveLength(0);
    });

    it('unwraps the API envelope ({ statusCode, type, data }) of a success', async () => {
        const f = fakeFetch(200, { statusCode: 200, type: 'Object', data: { text: 'plan', usage: { inputTokens: 3, outputTokens: 2 } } });
        const res = await new HttpLlmGateway("http://api.test", { secrets, fetch: f.fn }).complete(req);
        expect(res).toEqual({ text: 'plan', usage: { inputTokens: 3, outputTokens: 2 } });
    });
});
