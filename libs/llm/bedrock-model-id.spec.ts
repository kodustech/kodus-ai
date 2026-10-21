import {
    bedrockGeographyPrefix,
    repairBedrockModelId,
} from './bedrock-model-id';

describe('repairBedrockModelId — an id AWS cannot serve as written', () => {
    // "Invocation of model ID anthropic.claude-sonnet-4-6 with on-demand
    //  throughput isn't supported. Retry your request with the ID or ARN of an
    //  inference profile that contains this model."
    //
    // Read off a live Bedrock call, not from a doc. One production slot carries
    // exactly that id — the only one of five Bedrock-Claude configs without a
    // prefix — so it has never worked, in a fallback nobody watches.
    it.each([
        [undefined, 'us.anthropic.claude-sonnet-4-6'],
        ['us-east-1', 'us.anthropic.claude-sonnet-4-6'],
        ['eu-central-1', 'eu.anthropic.claude-sonnet-4-6'],
        ['ap-southeast-1', 'apac.anthropic.claude-sonnet-4-6'],
    ])('prefixes a bare Anthropic id for %s', (region, expected) => {
        expect(repairBedrockModelId('anthropic.claude-sonnet-4-6', region)).toBe(
            expected,
        );
    });

    // Geography, not region: every eu-* shares one profile prefix.
    it('derives the prefix from the geography, not the region name', () => {
        expect(bedrockGeographyPrefix('eu-west-3')).toBe('eu.');
        expect(bedrockGeographyPrefix('ap-northeast-1')).toBe('apac.');
        expect(bedrockGeographyPrefix('us-west-2')).toBe('us.');
        // Unrecognized falls to the slot's own default region's geography.
        expect(bedrockGeographyPrefix('')).toBe('us.');
    });

    it.each([
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'eu.anthropic.claude-opus-4-8',
        'global.anthropic.claude-opus-4-7',
        'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6',
    ])('leaves an already-routed id alone: %s', (id) => {
        expect(repairBedrockModelId(id, 'us-east-1')).toBe(id);
    });

    // Deliberately narrow. The other Bedrock families appear in production both
    // bare and prefixed and none has been observed failing, so repairing them
    // would break ids that work today to fix ones nobody has shown are broken.
    it.each([
        'moonshotai.kimi-k2.5',
        'minimax.minimax-m2',
        'openai.gpt-5.6-sol',
        'xai.grok-4.6',
    ])('does not touch a non-Anthropic family: %s', (id) => {
        expect(repairBedrockModelId(id, 'us-east-1')).toBe(id);
    });

    // The generations AWS did serve as bare foundation models. Claude 3.5
    // Sonnet launched on-demand under its bare id and answers to it today, so
    // prefixing it is not a repair — it silently moves a working slot onto a
    // cross-region profile, changing where the call routes and how it bills,
    // and failing outright in an account with no such profile.
    //
    // 3.7 is deliberately NOT exempt: it arrived requiring an inference
    // profile, so it belongs with the generations that are repaired.
    it.each([
        'anthropic.claude-3-5-sonnet-20240620-v1:0',
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
        'anthropic.claude-3-5-haiku-20241022-v1:0',
        'anthropic.claude-3-opus-20240229-v1:0',
        'anthropic.claude-3-sonnet-20240229-v1:0',
        'anthropic.claude-3-haiku-20240307-v1:0',
    ])('leaves a bare Claude 3.x id alone — AWS serves it on demand: %s', (id) => {
        expect(repairBedrockModelId(id, 'us-east-1')).toBe(id);
    });

    it('still repairs 3.7, which shipped profile-only', () => {
        expect(
            repairBedrockModelId('anthropic.claude-3-7-sonnet-20250219-v1:0', 'us-east-1'),
        ).toBe('us.anthropic.claude-3-7-sonnet-20250219-v1:0');
    });

    it('leaves an empty id alone rather than inventing one', () => {
        expect(repairBedrockModelId('', 'us-east-1')).toBe('');
    });
});
