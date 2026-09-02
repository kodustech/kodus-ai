import {
    normalizeAnthropicModelName,
    resolveAnthropicModelTraits,
    supportsSamplingParams,
    type AnthropicGeneration,
} from './traits';

describe('normalizeAnthropicModelName', () => {
    it.each([
        ['anthropic:claude-opus-5', 'claude-opus-5'],
        ['anthropic.claude-opus-5', 'claude-opus-5'],
        ['claude-opus-4-5@20251101', 'claude-opus-4-5'],
        ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
        ['  Claude-Opus-5  ', 'claude-opus-5'],
        [undefined, ''],
        // Bedrock decorations, verbatim from production slots. Each one used to
        // fall through to `unknown`, which withholds temperature and omits the
        // thinking config — silently, on the models that need both.
        ['global.anthropic.claude-opus-4-7', 'claude-opus-4-7'],
        ['eu.anthropic.claude-opus-4-8', 'claude-opus-4-8'],
        ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
    ])('%s → %s', (input, expected) => {
        expect(normalizeAnthropicModelName(input)).toBe(expected);
    });

    it('a Bedrock-hosted Claude resolves to the SAME generation as the bare id', () => {
        // The host does not change the model. Anything else means the same
        // Claude answers one way on Anthropic and another way on Bedrock — the
        // divergence this whole layer exists to prevent.
        const pairs: Array<[string, string]> = [
            ['global.anthropic.claude-opus-4-7', 'claude-opus-4-7'],
            ['eu.anthropic.claude-opus-4-8', 'claude-opus-4-8'],
            ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
            ['anthropic.claude-sonnet-4-6', 'claude-sonnet-4-6'],
        ];
        for (const [hosted, bare] of pairs) {
            expect({
                id: hosted,
                traits: resolveAnthropicModelTraits(hosted),
            }).toEqual({ id: hosted, traits: resolveAnthropicModelTraits(bare) });
        }
    });
});

describe('resolveAnthropicModelTraits', () => {
    const cases: Array<[string, AnthropicGeneration]> = [
        // Legacy — budget_tokens is required, adaptive is rejected. The line is
        // 3.7, where extended thinking arrives: everything before it has no
        // thinking parameter at all, which is a different fact from "thinks with
        // a budget". This row used to say `legacy` for 3.5, agreeing with a
        // regex that answered both questions with one match — while
        // `anthropicReasoningConfig`, four functions away in the same file, drew
        // the line correctly and reported 3.5 as non-reasoning. The capability
        // table said no and the emitter sent thinking anyway.
        ['claude-3-7-sonnet-20250219', 'legacy'],
        ['claude-3-5-sonnet-20241022', 'pre-thinking'],
        ['claude-3-opus-20240229', 'pre-thinking'],
        ['claude-2.1', 'pre-thinking'],
        ['claude-opus-4-20250514', 'legacy'],
        ['claude-opus-4-1-20250805', 'legacy'],
        ['claude-opus-4-5', 'legacy'],
        ['claude-sonnet-4-5-20250929', 'legacy'],
        ['claude-haiku-4-5', 'legacy'],

        // 4.6 — adaptive, but still accepts sampling params.
        ['claude-opus-4-6', 'adaptive-4-6'],
        ['claude-sonnet-4-6', 'adaptive-4-6'],

        // 4.7+ and the 5 line — adaptive only, no sampling params.
        ['claude-opus-4-7', 'modern'],
        ['claude-opus-4-8', 'modern'],
        ['claude-opus-5', 'modern'],
        ['claude-sonnet-5', 'modern'],

        // Thinking cannot be switched off on these.
        ['claude-fable-5', 'always-thinking'],
        ['claude-mythos-5', 'always-thinking'],
        ['claude-mythos-preview', 'always-thinking'],

        // Not a Claude model id at all.
        ['kodus-generalist-review-agent', 'unknown'],
        ['gpt-5.2', 'unknown'],
        ['', 'unknown'],
    ];

    it.each(cases)('%s → %s', (model, generation) => {
        expect(resolveAnthropicModelTraits(model).generation).toBe(generation);
    });

    it('resolves a future Claude to modern without a code change', () => {
        // The whole point of the open-ended patterns: a model released after
        // this file was written must not fall back to the legacy shape, which
        // 4.7+ rejects outright.
        for (const model of [
            'claude-opus-6',
            'claude-sonnet-7',
            'claude-opus-4-12',
        ]) {
            const traits = resolveAnthropicModelTraits(model);
            expect(traits.generation).toBe('modern');
            expect(traits.thinkingShape).toBe('adaptive');
            expect(traits.supportsSamplingParams).toBe(false);
        }
    });

    it('maps generation to the wire shape', () => {
        expect(resolveAnthropicModelTraits('claude-sonnet-4-5')).toEqual({
            generation: 'legacy',
            thinkingShape: 'budget',
            canDisableThinking: true,
            supportsSamplingParams: true,
        });

        expect(resolveAnthropicModelTraits('claude-opus-5')).toEqual({
            generation: 'modern',
            thinkingShape: 'adaptive',
            canDisableThinking: true,
            supportsSamplingParams: false,
        });

        expect(resolveAnthropicModelTraits('claude-fable-5')).toEqual({
            generation: 'always-thinking',
            thinkingShape: 'adaptive',
            canDisableThinking: false,
            supportsSamplingParams: false,
        });

        expect(resolveAnthropicModelTraits('mystery-model')).toEqual({
            generation: 'unknown',
            thinkingShape: 'none',
            canDisableThinking: true,
            supportsSamplingParams: false,
        });
    });
});

describe('supportsSamplingParams', () => {
    it('never withholds temperature from non-Anthropic providers', () => {
        // anthropic_compatible endpoints (Kimi Code, Z.ai, DeepSeek) speak the
        // Anthropic protocol but do accept temperature — and kimi-k2.7-code
        // requires temperature=1, so a blanket rule keyed on the protocol
        // rather than the provider would break it.
        expect(supportsSamplingParams(false, 'claude-opus-5')).toBe(true);
        expect(supportsSamplingParams(false, 'kimi-k2.7-code')).toBe(true);
    });

    it('withholds temperature from 4.7+ Anthropic models (400 otherwise)', () => {
        expect(supportsSamplingParams(true, 'claude-opus-5')).toBe(false);
        expect(supportsSamplingParams(true, 'claude-opus-4-7')).toBe(false);
        expect(supportsSamplingParams(true, 'claude-fable-5')).toBe(false);
    });

    it('keeps temperature for Anthropic models that still accept it', () => {
        expect(supportsSamplingParams(true, 'claude-sonnet-4-5')).toBe(true);
        expect(supportsSamplingParams(true, 'claude-opus-4-6')).toBe(true);
        expect(supportsSamplingParams(true, 'claude-3-7-sonnet')).toBe(true);
    });

    it('withholds temperature from an unidentified Anthropic model', () => {
        // Biased toward the request succeeding: a newer-than-known Claude 400s
        // on temperature, while dropping it only costs determinism.
        expect(supportsSamplingParams(true, undefined)).toBe(false);
        expect(supportsSamplingParams(true, 'claude-something-new')).toBe(false);
    });
});
