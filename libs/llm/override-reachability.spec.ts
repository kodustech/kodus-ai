/**
 * The detector's own contract. Every case here is drawn from a request body a
 * real adapter built (captured in `byok-config-matrix`), not invented — the
 * point of this file is that a rename must NOT read as a drop, and the two live
 * drops must.
 */
import {
    describeDroppedEffort,
    describeUnreachedKeys,
    reasoningEffortWasDropped,
    unreachedOverrideKeys,
} from './override-reachability';

describe('unreachedOverrideKeys', () => {
    it('does not flag a key the adapter faithfully RENAMED', () => {
        // `@ai-sdk/anthropic` declares `effort` and renders `output_config.effort`
        // on the wire. Matching key names would call this a drop; matching values
        // sees "high" arrive and calls it what it is — a translation.
        expect(
            unreachedOverrideKeys(
                { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } },
                {
                    model: 'claude-sonnet-5',
                    thinking: { type: 'adaptive' },
                    output_config: { effort: 'high' },
                },
            ),
        ).toEqual([]);
    });

    it('flags the wire spelling a live org pasted, and only that half', () => {
        // The real config: Anthropic's own API docs show `output_config`, so that
        // is what was pasted. The adapter has no such option and strips it; the
        // `thinking` half lands. "The request changed" is true throughout, which
        // is why the coarser check cannot see this.
        expect(
            unreachedOverrideKeys(
                {
                    anthropic: {
                        thinking: { type: 'adaptive' },
                        output_config: { effort: 'high' },
                    },
                },
                {
                    model: 'claude-sonnet-5',
                    thinking: { type: 'adaptive' },
                },
            ),
        ).toEqual([{ namespace: 'anthropic', key: 'output_config' }]);
    });

    it('flags a top-level snake_case key the OpenAI-compatible schema strips', () => {
        // The second live one. Nested inside `thinking` the same word rides along
        // as an opaque sub-object; at the top level it is a key the schema does
        // not declare, and it is gone.
        expect(
            unreachedOverrideKeys(
                {
                    openaiCompatible: {
                        reasoning_effort: 'max',
                        thinking: { type: 'enabled' },
                    },
                },
                '{"model":"deepseek-v4-flash","thinking":{"type":"enabled"}}',
            ),
        ).toEqual([{ namespace: 'openaiCompatible', key: 'reasoning_effort' }]);
    });

    it('reads a body the adapter handed back as a STRING', () => {
        // The OpenAI-compatible adapter returns the serialized body; the Anthropic
        // and Google ones return an object. Both are the same question.
        expect(
            unreachedOverrideKeys(
                { openaiCompatible: { thinking: { type: 'enabled' } } },
                '{"thinking":{"type":"enabled"}}',
            ),
        ).toEqual([]);
    });

    it('says nothing when there is no evidence either way', () => {
        // No body (an adapter that does not retain one), an empty value with no
        // scalars to trace, and a namespace that is not an object. Silence is the
        // only honest answer to each — a warning here would be a guess.
        expect(unreachedOverrideKeys({ anthropic: { effort: 'high' } }, undefined))
            .toEqual([]);
        expect(
            unreachedOverrideKeys({ anthropic: { thinking: {} } }, { model: 'x' }),
        ).toEqual([]);
        expect(
            unreachedOverrideKeys({ anthropic: 'nope' } as any, { model: 'x' }),
        ).toEqual([]);
    });

    it('under-reports rather than false-alarms on a colliding value', () => {
        // `true` appears in the body for an unrelated reason, so a dropped flag
        // whose only value is `true` reads as reached. That direction is chosen:
        // a warning people learn to ignore is worse than one that misses.
        expect(
            unreachedOverrideKeys(
                { openaiCompatible: { madeUpFlag: true } },
                { stream: true },
            ),
        ).toEqual([]);
    });
});

describe('describeUnreachedKeys', () => {
    it('is silent when everything landed', () => {
        expect(describeUnreachedKeys([])).toBeUndefined();
        expect(describeUnreachedKeys(undefined)).toBeUndefined();
    });

    it('names the keys and points at the example, without guessing a spelling', () => {
        const msg = describeUnreachedKeys([
            { namespace: 'anthropic', key: 'output_config' },
        ])!;
        expect(msg).toContain('"output_config"');
        expect(msg).toContain('example');
        // No invented correction: the module's example is what teaches the right
        // key, and it is already on screen under the box.
        expect(msg).not.toContain('effort"');
    });
});

describe('reasoningEffortWasDropped', () => {
    it('is true when the module emitted nothing — no body needed', () => {
        // Grok / MiniMax / Kimi on Bedrock Converse: known reasoners, live
        // slots, and `reasoning()` returns {} because the transport has no
        // mapping we can verify. There is no request that could have carried it,
        // so the answer does not depend on one.
        expect(reasoningEffortWasDropped({}, { model: 'x' })).toBe(true);
        expect(reasoningEffortWasDropped(undefined, undefined)).toBe(true);
    });

    it('is false when the effort landed under a DIFFERENT name', () => {
        // Gemini turns an effort into a token budget, so the word "high" never
        // appears on the wire. Tracing values, not names, keeps that a pass.
        expect(
            reasoningEffortWasDropped(
                { google: { thinkingConfig: { thinkingBudget: 32768 } } },
                {
                    generationConfig: {
                        thinkingConfig: { thinkingBudget: 32768 },
                    },
                },
            ),
        ).toBe(false);
    });

    it('is true when we asked and the adapter dropped it anyway', () => {
        // `gpt-4o-mini` with effort high: we emit `reasoningEffort`, the OpenAI
        // adapter strips it for a model that cannot reason, and the user is left
        // believing a non-reasoning model is reasoning.
        expect(
            reasoningEffortWasDropped(
                { openai: { reasoningEffort: 'high' } },
                { model: 'gpt-4o-mini', messages: [] },
            ),
        ).toBe(true);
    });

    it('withholds a verdict when the adapter kept no body', () => {
        // We asked for something and cannot see what was sent. Reporting a drop
        // here would be a guess dressed as a finding.
        expect(
            reasoningEffortWasDropped(
                { openai: { reasoningEffort: 'high' } },
                undefined,
            ),
        ).toBe(false);
    });
});

describe('describeDroppedEffort', () => {
    it('names the effort and does not promise a fix', () => {
        const msg = describeDroppedEffort('high');
        expect(msg).toContain('"high"');
        expect(msg).toContain('no effect');
        // Two of the three causes cannot be fixed on this screen, so it explains
        // rather than instructs.
        expect(msg).toContain('proxy');
    });
});
