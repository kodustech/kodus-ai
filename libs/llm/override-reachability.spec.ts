/**
 * The detector's own contract. Every case here is drawn from a request body a
 * real adapter built (captured in `byok-config-matrix`), not invented — the
 * point of this file is that a rename must NOT read as a drop, and the two live
 * drops must.
 */
import {
    describeUnreachedKeys,
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
