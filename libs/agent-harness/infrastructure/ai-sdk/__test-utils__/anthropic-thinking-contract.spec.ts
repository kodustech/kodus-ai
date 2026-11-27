import { samePrefix, thinkingContractViolations } from './anthropic-thinking-contract';

const signed = (sig: string) => ({
    role: 'assistant',
    content: [{ type: 'reasoning', text: 't', providerOptions: { anthropic: { signature: sig } } }],
});

/** The checker the e2e specs trust: it must flag what Anthropic rejects, and nothing else. */
describe('thinkingContractViolations', () => {
    const head = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];

    it('passes a block replayed after the prefix it was made with', () => {
        expect(
            thinkingContractViolations([
                { prompt: head, tools: ['a'] },
                { prompt: [...head, signed('sig-1')], tools: ['a'] },
            ]),
        ).toEqual([]);
    });

    it('passes the same prefix written with its properties in another order', () => {
        const reordered = [{ content: [{ text: 'go', type: 'text' }], role: 'user' }];
        expect(samePrefix(head, reordered)).toBe(true);
        expect(
            thinkingContractViolations([
                { prompt: head, tools: ['a'] },
                { prompt: [...reordered, signed('sig-1')], tools: ['a'] },
            ]),
        ).toEqual([]);
    });

    it('passes a prefix that differs only by a moved cache marker', () => {
        const marked = [
            { role: 'user', content: [{ type: 'text', text: 'go', cacheControl: { type: 'ephemeral' } }] },
        ];
        expect(samePrefix(head, marked)).toBe(true);
    });

    it('flags a block replayed after its prefix changed', () => {
        const edited = [{ role: 'user', content: [{ type: 'text', text: 'go (cut)' }] }];
        expect(
            thinkingContractViolations([
                { prompt: head, tools: ['a'] },
                { prompt: [...edited, signed('sig-1')], tools: ['a'] },
            ]),
        ).toEqual(['call 2: sig-1 replayed after its prefix changed']);
    });

    it('flags a block replayed with a different tool list', () => {
        expect(
            thinkingContractViolations([
                { prompt: head, tools: ['a', 'b'] },
                { prompt: [...head, signed('sig-1')], tools: ['a'] },
            ]),
        ).toEqual(['call 2: sig-1 replayed with a different tool list']);
    });

    it('flags a block no recorded call produced', () => {
        expect(
            thinkingContractViolations([{ prompt: [...head, signed('sig-9')], tools: [] }]),
        ).toEqual(['call 1: unknown block sig-9']);
    });
});
