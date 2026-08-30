/**
 * CHARACTERIZATION / regression net for `applyCacheBreakpoints` — the ONE seam
 * `LLM.run` uses to stamp prompt-cache breakpoints on a model call. This pins the
 * behaviour that exists TODAY so any future per-provider cache work (Gemini
 * CachedContent, rolling Anthropic, a `cacheStrategy()` refactor) can't silently
 * regress the Anthropic caching that already works.
 *
 * Uses the REAL registry (provider modules self-register), so it exercises the
 * actual protocol-aware decision, not a mock.
 */
import {
    applyCacheBreakpoints,
    markLatestUserForCache,
} from './prompt-cache';
import type { ModelMessage } from 'ai';

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

const userMsg = (text = 'hi'): ModelMessage => ({ role: 'user', content: text });
const tools = () => ({ findFile: { description: 'a' }, listDir: { description: 'b' } });

describe('applyCacheBreakpoints — multi-step gate', () => {
    it('single-step (maxSteps=1) applies NOTHING, even for Anthropic (write premium never pays back)', () => {
        const messages = [userMsg()];
        const t = tools();
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 1,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        // Pass-through: same references, plain system string.
        expect(out.systemArg).toBe('SYS');
        expect(out.callMessages).toBe(messages);
        expect(out.callTools).toBe(t);
    });
});

describe('applyCacheBreakpoints — Anthropic (honors inline markers)', () => {
    it('multi-step stamps all THREE breakpoints: system + latest user + last tool', () => {
        const messages = [userMsg('older'), { role: 'assistant', content: 'x' } as ModelMessage, userMsg('latest')];
        const t = tools();
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 4,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });

        // system → object message carrying the ephemeral marker
        expect(out.systemArg).toEqual({
            role: 'system',
            content: 'SYS',
            providerOptions: EPHEMERAL,
        });
        // latest user (index 2), NOT the older one, gets the marker
        expect(out.callMessages).not.toBe(messages);
        expect((out.callMessages[2] as any).providerOptions).toEqual(EPHEMERAL);
        expect((out.callMessages[0] as any).providerOptions).toBeUndefined();
        // last tool (listDir) gets the marker; the first does not
        expect(out.callTools).not.toBe(t);
        expect((out.callTools as any).listDir.providerOptions).toEqual(EPHEMERAL);
        expect((out.callTools as any).findFile.providerOptions).toBeUndefined();
    });

    it('anthropic_compatible (Kimi/GLM over the anthropic protocol) also gets the marker', () => {
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages: [userMsg()],
            tools: tools(),
            maxSteps: 2,
            provider: 'anthropic_compatible',
            model: 'kimi-k2-code',
        });
        expect((out.systemArg as any).providerOptions).toEqual(EPHEMERAL);
    });

    it('a system-less call leaves systemArg undefined (no empty system message)', () => {
        const out = applyCacheBreakpoints({
            system: undefined,
            messages: [userMsg()],
            tools: tools(),
            maxSteps: 2,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect(out.systemArg).toBeUndefined();
        // ...but the message/tool breakpoints still apply.
        expect((out.callMessages[0] as any).providerOptions).toEqual(EPHEMERAL);
    });

    it('managed/env default (no provider) falls back to model-name detection', () => {
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages: [userMsg()],
            tools: tools(),
            maxSteps: 2,
            provider: undefined,
            model: 'claude-sonnet-4',
        });
        expect((out.systemArg as any).providerOptions).toEqual(EPHEMERAL);
    });

    it('accepts a built model object (.modelId) for the fallback path', () => {
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages: [userMsg()],
            tools: tools(),
            maxSteps: 2,
            provider: undefined,
            model: { modelId: 'claude-3-opus' },
        });
        expect((out.systemArg as any).providerOptions).toEqual(EPHEMERAL);
    });
});

describe('applyCacheBreakpoints — implicit-cache / unknown providers (no inline markers)', () => {
    it.each([
        ['openai', 'gpt-4o'],
        ['openai_compatible', 'some-model'],
        ['novita', 'meta-llama/llama-3-70b'],
        ['open_router', 'anthropic/claude-3.5-sonnet'], // Claude via OpenRouter → still no anthropic hint
    ])('%s / %s passes everything through untouched', (provider, model) => {
        const messages = [userMsg()];
        const t = tools();
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 4,
            provider,
            model,
        });
        expect(out.systemArg).toBe('SYS');
        expect(out.callMessages).toBe(messages);
        expect(out.callTools).toBe(t);
    });
});

describe('applyCacheBreakpoints — degenerate inputs stay safe', () => {
    it('no user message + no tools: system marked, the rest no-op (same refs)', () => {
        const messages: ModelMessage[] = [
            { role: 'assistant', content: 'x' },
        ];
        const t = {};
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: t,
            maxSteps: 2,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect((out.systemArg as any).providerOptions).toEqual(EPHEMERAL);
        // markLatestUserForCache/markLastToolForCache return the same ref when
        // there's nothing to mark.
        expect(out.callMessages).toBe(messages);
        expect(out.callTools).toBe(t);
    });

    it('is consistent with markLatestUserForCache applied directly', () => {
        // Guards that the orchestrator uses the same stamper (no drift).
        const messages = [userMsg('a'), userMsg('b')];
        const out = applyCacheBreakpoints({
            system: 'SYS',
            messages,
            tools: {},
            maxSteps: 2,
            provider: 'anthropic',
            model: 'claude-sonnet-4',
        });
        expect(out.callMessages).toEqual(
            markLatestUserForCache(messages, EPHEMERAL),
        );
    });
});
