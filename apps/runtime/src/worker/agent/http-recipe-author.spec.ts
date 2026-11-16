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

    it('sends again a request the product never received (a restart), then gives up naming the cause', async () => {
        const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
        let calls = 0;
        const flaky: FetchLike = async (...a) => {
            calls++;
            if (calls < 3) throw refused();
            return fakeFetch(200, { statusCode: 200, type: 'Object', data: { status: 'submitted', recipe: RECIPE, usage: { inputTokens: 1, outputTokens: 1 } } }).fn(...a);
        };
        const slept: number[] = [];
        const sleep = async (ms: number) => void slept.push(ms);
        expect(await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: flaky, sleep, connectRetryDelaysMs: [1, 2, 3] }).author(req)).toMatchObject({ status: 'submitted' });
        expect(slept).toEqual([1, 2]);

        const down: FetchLike = async () => {
            throw refused();
        };
        const gaveUp = await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: down, sleep, connectRetryDelaysMs: [1, 2] }).author(req);
        expect(gaveUp).toEqual({ status: 'unavailable', code: 'llm_unavailable', message: 'the product did not answer (TypeError: ECONNREFUSED)' });

        // A failure after the request may have reached Kody (a reset, a timeout) is never sent again.
        let once = 0;
        const reset: FetchLike = async () => {
            once++;
            throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
        };
        await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: reset, sleep, connectRetryDelaysMs: [1, 2] }).author(req);
        expect(once).toBe(1);
    });

    it("names the network failure's cause code, not only fetch's bare TypeError", async () => {
        const timedOut: FetchLike = async () => {
            throw new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
        };
        const out = await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: timedOut }).author(req);
        expect(out).toEqual({ status: 'unavailable', code: 'llm_unavailable', message: 'the product did not answer (TypeError: UND_ERR_HEADERS_TIMEOUT)' });
        const odd: FetchLike = async () => {
            throw new TypeError('fetch failed', { cause: { code: 'has spaces <b>' } });
        };
        expect(await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: odd }).author(req)).toMatchObject({ message: 'the product did not answer (TypeError)' });
    });

    it('waits on the headers as long as its own timeout, past undici\'s 300 s default', async () => {
        const http = await import('node:http');
        const server = http.createServer((_req, res) => {
            setTimeout(() => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ statusCode: 200, type: 'ok', data: { status: 'submitted', recipe: RECIPE, usage: { inputTokens: 1, outputTokens: 1 } } }));
            }, 300);
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        try {
            const { port } = server.address() as { port: number };
            const out = await new HttpRecipeAuthorClient(`http://127.0.0.1:${port}`, { secrets, timeoutMs: 5_000 }).author(req);
            expect(out).toMatchObject({ status: "submitted", recipe: RECIPE });
        } finally {
            server.close();
        }
    });

    describe('`last` and a product older than this worker', () => {
        const last = { recipe: RECIPE, notes: 'booted at the previous commit' };
        const submitted = { status: 'submitted', recipe: RECIPE, usage: { inputTokens: 1, outputTokens: 1 } };
        const answers = (...replies: Array<[number, unknown]>) => {
            const calls: any[] = [];
            const fn: FetchLike = async (url, init) => {
                calls.push({ url, init });
                const [status, body] = replies[Math.min(calls.length - 1, replies.length - 1)];
                return { status, ok: status >= 200 && status < 300, json: async () => body };
            };
            return { fn, calls };
        };

        it('sends `last` when the setup has one', async () => {
            const f = answers([200, submitted]);
            expect(await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: f.fn }).author({ ...req, last })).toMatchObject({ status: 'submitted' });
            expect(f.calls.map((c) => JSON.parse(c.init.body))).toEqual([{ sha: SHA, last }]);
        });

        it('on a 400 asks once more without `last`, and reads that answer', async () => {
            const f = answers([400, { message: 'Unrecognized key: last' }], [200, submitted]);
            expect(await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: f.fn }).author({ ...req, last })).toMatchObject({ status: 'submitted' });
            expect(f.calls.map((c) => JSON.parse(c.init.body))).toEqual([{ sha: SHA, last }, { sha: SHA }]);
        });

        it('a product older than `reauthor` refuses it with a 400: asked again with `last` alone, which it answers as is', async () => {
            const f = answers([400, { message: 'Unrecognized key: reauthor' }], [200, { ...submitted, reused: true }]);
            expect(await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: f.fn }).author({ ...req, last, reauthor: { from: 1, to: 2 } })).toMatchObject({ status: 'submitted', reused: true });
            expect(f.calls.map((c) => JSON.parse(c.init.body))).toEqual([{ sha: SHA, last, reauthor: { from: 1, to: 2 } }, { sha: SHA, last }]);
        });

        it('retries only once, and never without a `last` to drop', async () => {
            const twice = answers([400, {}], [400, {}]);
            expect(await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: twice.fn }).author({ ...req, last })).toEqual({ status: 'unavailable', code: 'llm_unavailable', message: 'the product answered 400' });
            expect(twice.calls).toHaveLength(2);
            const plain = answers([400, {}]);
            expect(await new HttpRecipeAuthorClient('http://api.test', { secrets, fetch: plain.fn }).author(req)).toMatchObject({ status: 'unavailable' });
            expect(plain.calls).toHaveLength(1);
        });
    });

    // The product keeps one outcome per setup and attempt (author-0, repair-<n>) and answers a repeat with it,
    // so a call whose answer may have been lost is asked again: Kody does not run twice.
    describe('`attempt`, which the product deduplicates', () => {
        const submitted = { status: 'submitted', recipe: RECIPE, usage: { inputTokens: 1, outputTokens: 1 } };
        const last = { recipe: RECIPE, notes: 'booted at the previous commit' };
        type Reply = [number, unknown] | Error;
        const net = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
        /** Answers in turn (the last one again once they run out), on a clock only the sleeps move. */
        const product = (...replies: Reply[]) => {
            let clock = 0;
            const bodies: unknown[] = [];
            const slept: number[] = [];
            const fn: FetchLike = async (_url, init) => {
                bodies.push(JSON.parse(init.body));
                const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
                if (r instanceof Error) throw r;
                return { status: r[0], ok: r[0] >= 200 && r[0] < 300, json: async () => r[1] };
            };
            const opts = { secrets, fetch: fn, now: () => clock, sleep: async (ms: number) => void (slept.push(ms), (clock += ms)) };
            return { opts, bodies, slept };
        };

        it('names the attempt in the request', async () => {
            const p = product([200, submitted]);
            expect(await new HttpRecipeAuthorClient('http://api.test', p.opts).author({ ...req, attempt: 'author-0' })).toMatchObject({ status: 'submitted' });
            expect(p.bodies).toEqual([{ sha: SHA, attempt: 'author-0' }]);
        });

        it("asks again, same attempt, after a failure that may have reached the product: a reset, a hang-up, a timeout, a restarting product's 502 or 503", async () => {
            const p = product(net('ECONNRESET'), net('UND_ERR_SOCKET'), net('UND_ERR_HEADERS_TIMEOUT'), [502, {}], [503, {}], [200, submitted]);
            const out = await new HttpRecipeAuthorClient('http://api.test', { ...p.opts, connectRetryDelaysMs: [1, 2, 3, 4, 5] }).author({ ...req, attempt: 'repair-1', last });
            expect(out).toMatchObject({ status: 'submitted' });
            expect(p.bodies).toEqual(Array(6).fill({ sha: SHA, attempt: 'repair-1', last }));
            expect(p.slept).toEqual([1, 2, 3, 4, 5]);

            const down = product(net('ECONNRESET'));
            const gaveUp = await new HttpRecipeAuthorClient('http://api.test', { ...down.opts, connectRetryDelaysMs: [1, 2] }).author({ ...req, attempt: 'repair-1' });
            expect(gaveUp).toEqual({ status: 'unavailable', code: 'llm_unavailable', message: 'the product did not answer (TypeError: ECONNRESET)' });
            expect(down.bodies).toHaveLength(3);
        });

        it("a 502 for Kody's own failed model call is the product's answer: not asked again", async () => {
            const p = product([502, { code: 'llm_unavailable' }], [200, submitted]);
            expect(await new HttpRecipeAuthorClient('http://api.test', { ...p.opts, connectRetryDelaysMs: [1] }).author({ ...req, attempt: 'author-0' })).toEqual({
                status: 'unavailable',
                code: 'llm_unavailable',
                message: 'the model call failed',
            });
            expect(p.bodies).toHaveLength(1);
        });

        it('while the product says the same attempt is still being written, waits and asks again, until the author timeout', async () => {
            const inProgress: Reply = [409, { statusCode: 409, code: 'author_in_progress' }];
            const p = product(inProgress, inProgress, [200, submitted]);
            expect(await new HttpRecipeAuthorClient('http://api.test', p.opts).author({ ...req, attempt: 'repair-2' })).toMatchObject({ status: 'submitted' });
            expect(p.bodies).toEqual(Array(3).fill({ sha: SHA, attempt: 'repair-2' }));

            const stuck = product(inProgress);
            const out = await new HttpRecipeAuthorClient('http://api.test', { ...stuck.opts, timeoutMs: 60_000 }).author({ ...req, attempt: 'repair-2' });
            expect(out).toEqual({ status: 'unavailable', code: 'llm_unavailable', message: 'Kody was still writing this recipe when the wait ran out' });
            expect(stuck.slept.reduce((a, b) => a + b, 0)).toBeLessThan(60_000);
        });

        it('a product older than `attempt` refuses it with a 400: asked again without it, keeping `last`, and a lost answer there is not asked again', async () => {
            const p = product([400, { message: 'Unrecognized key: attempt' }], net('ECONNRESET'));
            const out = await new HttpRecipeAuthorClient('http://api.test', { ...p.opts, connectRetryDelaysMs: [1, 2] }).author({ ...req, attempt: 'repair-1', last });
            expect(out).toMatchObject({ status: 'unavailable', message: 'the product did not answer (TypeError: ECONNRESET)' });
            expect(p.bodies).toEqual([
                { sha: SHA, attempt: 'repair-1', last },
                { sha: SHA, last },
            ]);

            const older = product([400, {}], [400, {}], [200, submitted]);
            expect(await new HttpRecipeAuthorClient('http://api.test', older.opts).author({ ...req, attempt: 'repair-1', last })).toMatchObject({ status: 'submitted' });
            expect(older.bodies).toEqual([{ sha: SHA, attempt: 'repair-1', last }, { sha: SHA, last }, { sha: SHA }]);
        });
    });
});
