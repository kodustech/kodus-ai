import type { ModelMessage } from 'ai';
import {
    markLastToolForCache,
    markLatestUserForCache,
    type CacheHint,
} from './prompt-cache';

const HINT: CacheHint = { anthropic: { cacheControl: { type: 'ephemeral' } } };

describe('markLastToolForCache', () => {
    it('stamps the hint on the LAST tool only', () => {
        const tools = { a: { description: 'a' }, b: { description: 'b' } };
        const out = markLastToolForCache(tools, HINT);
        expect(out.b.providerOptions).toEqual(HINT);
        expect((out.a as any).providerOptions).toBeUndefined();
    });

    it('merges into existing providerOptions without clobbering other vendors', () => {
        const tools = {
            only: { description: 'x', providerOptions: { openai: { foo: 1 } } },
        };
        const out = markLastToolForCache(tools, HINT);
        expect(out.only.providerOptions).toEqual({
            openai: { foo: 1 },
            anthropic: { cacheControl: { type: 'ephemeral' } },
        });
    });

    it('is a no-op (same reference) when there are no tools', () => {
        const tools = {};
        expect(markLastToolForCache(tools, HINT)).toBe(tools);
    });

    it('does not mutate the input map', () => {
        const tools = { a: { description: 'a' } };
        markLastToolForCache(tools, HINT);
        expect((tools.a as any).providerOptions).toBeUndefined();
    });
});

describe('markLatestUserForCache', () => {
    const user = (text: string): ModelMessage => ({ role: 'user', content: text });
    const assistant = (text: string): ModelMessage =>
        ({ role: 'assistant', content: text }) as ModelMessage;

    it('stamps the hint on the LAST user message', () => {
        const msgs: ModelMessage[] = [user('first'), assistant('a'), user('task')];
        const out = markLatestUserForCache(msgs, HINT);
        expect((out[2] as any).providerOptions).toEqual(HINT);
        // earlier user message untouched
        expect((out[0] as any).providerOptions).toBeUndefined();
    });

    it('is a no-op (same reference) when there is no user message', () => {
        const msgs: ModelMessage[] = [assistant('a')];
        expect(markLatestUserForCache(msgs, HINT)).toBe(msgs);
    });

    it('does not mutate the input array', () => {
        const msgs: ModelMessage[] = [user('task')];
        markLatestUserForCache(msgs, HINT);
        expect((msgs[0] as any).providerOptions).toBeUndefined();
    });

    it('merges into existing message providerOptions', () => {
        const msgs: ModelMessage[] = [
            { role: 'user', content: 'task', providerOptions: { x: { y: 1 } } } as any,
        ];
        const out = markLatestUserForCache(msgs, HINT);
        expect((out[0] as any).providerOptions).toEqual({
            x: { y: 1 },
            anthropic: { cacheControl: { type: 'ephemeral' } },
        });
    });
});
