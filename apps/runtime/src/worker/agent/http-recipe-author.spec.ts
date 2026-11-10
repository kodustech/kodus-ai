import { devSealKey } from '../../testing/dev-seal-key';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import type { FetchLike } from './http-llm-gateway';
import { HttpRecipeAuthorClient } from './http-recipe-author';

const TOKEN = 'kst1.fake-setup-token.sig';
const KEY = 'env-1:2026-10-30T12:00:00.000Z';
const SHA = 'c'.repeat(40);
const secrets = new SealedSecretOpener(devSealKey());
// The setup token arrives sealed for the setup key; the client opens it for the call only.
const req = { organizationId: 'org-1', llmToken: secrets.seal(TOKEN, KEY), setupKey: KEY, sha: SHA };
const RECIPE = 'version: 1\nservices:\n  compose:\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n';

const fakeFetch = (status: number, body: unknown) => {
    const calls: any[] = [];
    const fn: FetchLike = async (url, init) => {
        calls.push({ url, init });
        return { status, ok: status >= 200 && status < 300, json: async () => body };
    };
    return { fn, calls };
};

describe('HttpRecipeAuthorClient', () => {
    it('posts the commit with the setup token and reads the wrapped answer', async () => {
        const f = fakeFetch(200, { statusCode: 200, type: 'Object', data: { status: 'submitted', recipe: RECIPE, notes: 'root compose', usage: { inputTokens: 10, outputTokens: 5 } } });
        const out = await new HttpRecipeAuthorClient('http://api.test/', { secrets, fetch: f.fn }).author(req);
        expect(out).toEqual({ status: 'submitted', recipe: RECIPE, notes: 'root compose', usage: { inputTokens: 10, outputTokens: 5 } });
        expect(f.calls[0].url).toBe('http://api.test/internal/runtime/recipe-author');
        expect(f.calls[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(JSON.parse(f.calls[0].init.body)).toEqual({ sha: SHA });
    });

    it('never calls without a token that opens for this setup', async () => {
        const f = fakeFetch(200, {});
        const client = new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: f.fn });
        expect(await client.author({ ...req, llmToken: '' })).toMatchObject({ status: 'unavailable', code: 'llm_unavailable' });
        expect(await client.author({ ...req, setupKey: 'env-1:other' })).toMatchObject({ status: 'unavailable', code: 'llm_unavailable' });
        expect(f.calls).toHaveLength(0);
    });

    it('a spent budget, an error or a malformed answer is unavailable, never a recipe, and never echoes the token', async () => {
        const client = (status: number, body: unknown) => new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: fakeFetch(status, body).fn });
        expect(await client(429, { code: 'llm_budget_exceeded', scope: 'run' }).author(req)).toEqual({ status: 'unavailable', code: 'llm_budget_exceeded', message: "the setup's LLM budget is spent" });
        expect(await client(429, { code: 'llm_budget_exceeded', scope: 'org_day' }).author(req)).toMatchObject({ message: "the organization's LLM budget for today is spent" });
        // The product ran Kody and the model failed: unavailable, saying so (not a no_recipe verdict).
        expect(await client(502, { code: 'llm_unavailable', message: "Kody's model call failed" }).author(req)).toEqual({ status: 'unavailable', code: 'llm_unavailable', message: 'the model call failed' });
        for (const [status, body] of [
            [401, { message: TOKEN }],
            [502, {}],
            [503, {}],
            [200, { status: 'submitted', recipe: '', usage: { inputTokens: 1, outputTokens: 1 } }],
            [200, { status: 'boot_anything' }],
        ] as const) {
            const out = await client(status, body).author(req);
            expect(out.status).toBe('unavailable');
            expect(JSON.stringify(out)).not.toContain(TOKEN);
        }
        const down: FetchLike = async () => {
            throw new TypeError('fetch failed');
        };
        expect(await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: down }).author(req)).toMatchObject({ status: 'unavailable', code: 'llm_unavailable' });
    });
});
