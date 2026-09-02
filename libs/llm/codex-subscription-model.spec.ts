// Mutation-killing spec for the deterministic logic in codex-subscription-model.ts:
//   - readCodexAuth        (reads + validates the OAuth token file)
//   - buildCodexSubscriptionModel (wires createOpenAI + wraps in the stream→generate Proxy)
// The Proxy produced by withGenerateFromStream is exercised THROUGH the public
// buildCodexSubscriptionModel return value, since that is where its behaviour ships.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Control the underlying provider so we can assert wiring + drive the Proxy.
jest.mock('@ai-sdk/openai', () => ({
    createOpenAI: jest.fn(),
}));

import { createOpenAI } from '@ai-sdk/openai';
import {
    readCodexAuth,
    buildCodexSubscriptionModel,
    CODEX_PROVIDER_OPTIONS,
} from './codex-subscription-model';

const createOpenAIMock = createOpenAI as unknown as jest.Mock;

// ── helpers ────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'));

function writeAuth(name: string, obj: unknown): string {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
    return p;
}

// A fake stream matching the shape doGenerate consumes: `.getReader().read()`.
function fakeStream(chunks: any[]) {
    let i = 0;
    return {
        getReader() {
            return {
                read: async () =>
                    i < chunks.length
                        ? { done: false, value: chunks[i++] }
                        : { done: true, value: undefined },
            };
        },
    };
}

// Build a stub inner model whose doStream returns the given chunks, and records
// the options it was handed (so the injected store/effort/include can be asserted).
function makeInnerModel(chunks: any[]) {
    const doStream = jest.fn(async (_options: any) => ({
        stream: fakeStream(chunks),
    }));
    return {
        doStream,
        plainProp: 'passthrough-value',
    };
}

// Wire the createOpenAI mock so provider.responses(modelId) returns `model`,
// and capture how responses() was called.
function wireProvider(model: any) {
    const responses = jest.fn(() => model);
    createOpenAIMock.mockReturnValue({ responses });
    return { responses };
}

const AUTH = { token: 'tok-abc', accountId: 'acct-123' };

afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
});

describe('readCodexAuth', () => {
    it('returns exactly { token, accountId } from tokens.* on a valid file', () => {
        const p = writeAuth('valid.json', {
            auth_mode: 'oauth',
            tokens: { access_token: 'AAA', account_id: 'BBB', other: 'ignored' },
        });
        expect(readCodexAuth(p)).toEqual({ token: 'AAA', accountId: 'BBB' });
    });

    it('throws when access_token is missing (accountId present)', () => {
        const p = writeAuth('no-token.json', {
            auth_mode: 'oauth',
            tokens: { account_id: 'BBB' },
        });
        expect(() => readCodexAuth(p)).toThrow(/codex auth incompleto/);
    });

    it('throws when account_id is missing (token present)', () => {
        const p = writeAuth('no-acct.json', {
            auth_mode: 'apikey',
            tokens: { access_token: 'AAA' },
        });
        expect(() => readCodexAuth(p)).toThrow(/codex auth incompleto/);
    });

    it('treats an empty-string token as missing (|| guard, not just undefined)', () => {
        const p = writeAuth('empty-token.json', {
            tokens: { access_token: '', account_id: 'BBB' },
        });
        expect(() => readCodexAuth(p)).toThrow();
    });

    it('throws when the tokens object is entirely absent (optional-chain guard)', () => {
        const p = writeAuth('no-tokens.json', { auth_mode: 'x' });
        expect(() => readCodexAuth(p)).toThrow(/codex auth incompleto/);
    });

    it('error message pins the offending path and the auth_mode field', () => {
        const p = writeAuth('mode.json', {
            auth_mode: 'device_code',
            tokens: {},
        });
        expect(() => readCodexAuth(p)).toThrow(p);
        expect(() => readCodexAuth(p)).toThrow(/auth_mode=device_code/);
    });
});

describe('buildCodexSubscriptionModel — provider wiring', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.RECALL_REASONING_EFFORT;
        delete process.env.RECALL_NO_RETAINED_REASONING;
    });

    it('constructs createOpenAI with the codex base URL, token as apiKey, and exact headers', () => {
        const { responses } = wireProvider(makeInnerModel([]));

        buildCodexSubscriptionModel('gpt-5.6-luna', AUTH);

        expect(createOpenAIMock).toHaveBeenCalledTimes(1);
        expect(createOpenAIMock).toHaveBeenCalledWith({
            apiKey: 'tok-abc',
            baseURL: 'https://chatgpt.com/backend-api/codex',
            headers: {
                'chatgpt-account-id': 'acct-123',
                'OpenAI-Beta': 'responses=experimental',
                originator: 'codex_cli_rs',
            },
        });
        // The model id is threaded straight into provider.responses(...).
        expect(responses).toHaveBeenCalledWith('gpt-5.6-luna');
    });

    it('non-doStream/doGenerate property access falls through to the wrapped model', () => {
        wireProvider(makeInnerModel([]));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);
        expect(wrapped.plainProp).toBe('passthrough-value');
    });
});

describe('buildCodexSubscriptionModel — store/effort/include injection into doStream', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.RECALL_REASONING_EFFORT;
        delete process.env.RECALL_NO_RETAINED_REASONING;
    });

    it('injects store:false and the retained-reasoning include by default, preserving caller options', async () => {
        const inner = makeInnerModel([]);
        wireProvider(inner);
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        await wrapped.doGenerate({
            temperature: 1,
            providerOptions: { openai: { foo: 'bar' }, anthropic: { z: 1 } },
        });

        expect(inner.doStream).toHaveBeenCalledTimes(1);
        expect(inner.doStream).toHaveBeenCalledWith({
            temperature: 1,
            providerOptions: {
                anthropic: { z: 1 },
                openai: {
                    foo: 'bar',
                    store: false,
                    include: ['reasoning.encrypted_content'],
                },
            },
        });
    });

    it('adds reasoningEffort from RECALL_REASONING_EFFORT when set', async () => {
        process.env.RECALL_REASONING_EFFORT = 'high';
        const inner = makeInnerModel([]);
        wireProvider(inner);
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        await wrapped.doStream({});

        expect(inner.doStream).toHaveBeenCalledWith({
            providerOptions: {
                openai: {
                    store: false,
                    reasoningEffort: 'high',
                    include: ['reasoning.encrypted_content'],
                },
            },
        });
    });

    it('omits the include key only when RECALL_NO_RETAINED_REASONING === "1"', async () => {
        process.env.RECALL_NO_RETAINED_REASONING = '1';
        const inner = makeInnerModel([]);
        wireProvider(inner);
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        await wrapped.doStream({});

        const opts = inner.doStream.mock.calls[0][0];
        expect(opts.providerOptions.openai).toEqual({ store: false });
        expect('include' in opts.providerOptions.openai).toBe(false);
    });

    it('any other value for RECALL_NO_RETAINED_REASONING keeps the include (strict === "1")', async () => {
        process.env.RECALL_NO_RETAINED_REASONING = 'true';
        const inner = makeInnerModel([]);
        wireProvider(inner);
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        await wrapped.doStream({});

        const opts = inner.doStream.mock.calls[0][0];
        expect(opts.providerOptions.openai.include).toEqual([
            'reasoning.encrypted_content',
        ]);
    });
});

describe('buildCodexSubscriptionModel — doGenerate reassembly from the stream', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.RECALL_REASONING_EFFORT;
        delete process.env.RECALL_NO_RETAINED_REASONING;
    });

    it('reassembles text-first, reasoning-after, tool-call/file/source, finish + metadata + warnings', async () => {
        const chunks = [
            { type: 'stream-start', warnings: [{ w: 1 }] },
            { type: 'response-metadata', id: 'resp1', modelId: 'srv-model' },
            { type: 'reasoning-delta', id: 'a', delta: 'think' },
            { type: 'text-delta', id: 'x', delta: 'Hello ' },
            { type: 'text-delta', id: 'x', delta: 'world' },
            { type: 'tool-call', toolName: 'foo', args: { k: 1 } },
            { type: 'file', data: 'f' },
            { type: 'source', src: 's' },
            { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 5 } },
        ];
        wireProvider(makeInnerModel(chunks));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        const result = await wrapped.doGenerate({});

        expect(result).toEqual({
            content: [
                { type: 'text', text: 'Hello world' },
                { type: 'reasoning', text: 'think' },
                { type: 'tool-call', toolName: 'foo', args: { k: 1 } },
                { type: 'file', data: 'f' },
                { type: 'source', src: 's' },
            ],
            finishReason: 'tool-calls',
            usage: { inputTokens: 5 },
            warnings: [{ w: 1 }],
            response: { type: 'response-metadata', id: 'resp1', modelId: 'srv-model' },
        });
    });

    it('defaults: finishReason "stop", usage {}, response {}, warnings [] when the stream is empty', async () => {
        wireProvider(makeInnerModel([]));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        const result = await wrapped.doGenerate({});

        expect(result).toEqual({
            content: [],
            finishReason: 'stop',
            usage: {},
            warnings: [],
            response: {},
        });
    });

    it('text-delta uses id default "0" and delta default "" when absent', async () => {
        const chunks = [
            { type: 'text-delta' }, // no id, no delta → accumulates '' under '0'
            { type: 'text-delta', delta: 'A' },
            { type: 'text-delta', delta: 'B' },
        ];
        wireProvider(makeInnerModel(chunks));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        const result = await wrapped.doGenerate({});

        // All three collapse onto fragment id '0' → "AB".
        expect(result.content).toEqual([{ type: 'text', text: 'AB' }]);
    });

    it('drops empty text fragments (the `if (!text) continue` guard)', async () => {
        const chunks = [
            { type: 'text-delta', id: 'empty', delta: '' },
            { type: 'text-delta', id: 'real', delta: 'hi' },
        ];
        wireProvider(makeInnerModel(chunks));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        const result = await wrapped.doGenerate({});

        expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    });

    it('reasoning-delta is namespaced under a reasoning: fragment and emitted as type reasoning', async () => {
        const chunks = [{ type: 'reasoning-delta', id: 'r', delta: 'because' }];
        wireProvider(makeInnerModel(chunks));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        const result = await wrapped.doGenerate({});

        expect(result.content).toEqual([{ type: 'reasoning', text: 'because' }]);
    });

    it('a later finish chunk overrides an earlier one; last finishReason/usage win', async () => {
        const chunks = [
            { type: 'finish', finishReason: 'length', usage: { a: 1 } },
            { type: 'finish', finishReason: 'stop', usage: { b: 2 } },
        ];
        wireProvider(makeInnerModel(chunks));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        const result = await wrapped.doGenerate({});

        expect(result.finishReason).toBe('stop');
        expect(result.usage).toEqual({ b: 2 });
    });

    it('finish with nullish finishReason/usage keeps the running values', async () => {
        const chunks = [
            { type: 'finish', finishReason: 'length', usage: { a: 1 } },
            { type: 'finish' }, // finishReason/usage undefined → ?? falls back
        ];
        wireProvider(makeInnerModel(chunks));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        const result = await wrapped.doGenerate({});

        expect(result.finishReason).toBe('length');
        expect(result.usage).toEqual({ a: 1 });
    });

    it('response-metadata chunks are merged (later keys win)', async () => {
        const chunks = [
            { type: 'response-metadata', id: 'r1', region: 'us' },
            { type: 'response-metadata', id: 'r2' },
        ];
        wireProvider(makeInnerModel(chunks));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        const result = await wrapped.doGenerate({});

        expect(result.response).toEqual({
            type: 'response-metadata',
            id: 'r2',
            region: 'us',
        });
    });

    it('stream-start warnings are only collected when warnings is an array', async () => {
        const chunks = [
            { type: 'stream-start', warnings: 'not-an-array' },
            { type: 'stream-start', warnings: [{ code: 'x' }] },
        ];
        wireProvider(makeInnerModel(chunks));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        const result = await wrapped.doGenerate({});

        expect(result.warnings).toEqual([{ code: 'x' }]);
    });

    it('an error chunk carrying an Error rethrows that same Error instance', async () => {
        const boom = new Error('kaboom');
        wireProvider(makeInnerModel([{ type: 'error', error: boom }]));
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        await expect(wrapped.doGenerate({})).rejects.toBe(boom);
    });

    it('an error chunk carrying a non-Error is wrapped as Error(JSON.stringify(...))', async () => {
        wireProvider(
            makeInnerModel([{ type: 'error', error: { code: 'E_X', n: 7 } }]),
        );
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        await expect(wrapped.doGenerate({})).rejects.toThrow(
            JSON.stringify({ code: 'E_X', n: 7 }),
        );
    });

    it('tool-call content is tagged type "tool-call" and keeps its payload', async () => {
        wireProvider(
            makeInnerModel([
                { type: 'tool-call', toolCallId: 'c1', toolName: 'search', args: { q: 'x' } },
            ]),
        );
        const wrapped = buildCodexSubscriptionModel('m', AUTH);

        const result = await wrapped.doGenerate({});

        expect(result.content).toEqual([
            { type: 'tool-call', toolCallId: 'c1', toolName: 'search', args: { q: 'x' } },
        ]);
    });
});

describe('CODEX_PROVIDER_OPTIONS constant', () => {
    it('is exactly { openai: { store: false } }', () => {
        expect(CODEX_PROVIDER_OPTIONS).toEqual({ openai: { store: false } });
    });
});
