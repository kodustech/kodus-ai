import { bedrockModelListing } from './listing';

const listing = () => {
    const l = bedrockModelListing('amazon_bedrock');
    if (!l || l.kind !== 'http') throw new Error('expected an http listing');
    return l;
};

describe('bedrockModelListing', () => {
    it('is an http (live) listing for amazon_bedrock, null otherwise', () => {
        expect(bedrockModelListing('amazon_bedrock')?.kind).toBe('http');
        expect(bedrockModelListing('openai')).toBeNull();
    });

    it('builds the ListFoundationModels URL scoped to the user region', () => {
        const url = listing().url({
            awsBearerToken: 'ABSK-x',
            awsRegion: 'us-east-1',
        });
        expect(url).toBe(
            'https://bedrock.us-east-1.amazonaws.com/foundation-models',
        );
    });

    it('sends the bearer token as Authorization', () => {
        expect(
            listing().headers({ awsBearerToken: 'ABSK-x', awsRegion: 'us-east-1' })
                .Authorization,
        ).toBe('Bearer ABSK-x');
    });

    it('SSRF guard: refuses to build a host from an invalid/missing region', () => {
        // A region flows into the request host — a bad one must NOT shape the URL.
        expect(() =>
            listing().url({ awsBearerToken: 'x', awsRegion: 'evil.com/' }),
        ).toThrow(/region/i);
        expect(() => listing().url({ awsBearerToken: 'x' })).toThrow(/region/i);
    });

    it('parses modelSummaries → {id,name}, dropping non-ACTIVE (LEGACY)', () => {
        const models = listing().parse({
            modelSummaries: [
                {
                    modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
                    modelName: 'Claude Sonnet 4.5',
                    modelLifecycle: { status: 'ACTIVE' },
                },
                {
                    modelId: 'anthropic.dead-model-v1:0',
                    modelName: 'Dead',
                    modelLifecycle: { status: 'LEGACY' },
                },
            ],
        });
        expect(models.map((m) => m.id)).toEqual([
            'anthropic.claude-sonnet-4-5-20250929-v1:0',
        ]);
    });

    // Regression: ListInferenceProfiles only ever returned Anthropic (AWS built
    // it for Claude's cross-region routing), so a third-party marketplace model
    // like Kimi — invoked directly by its bare id, never registered as a
    // profile — could never appear in the picker. ListFoundationModels is the
    // base catalog: every family lives here.
    it('includes non-Anthropic marketplace models (e.g. Kimi) — the whole point of switching off ListInferenceProfiles', () => {
        const models = listing().parse({
            modelSummaries: [
                {
                    modelId: 'moonshotai.kimi-k2.5',
                    modelName: 'Kimi K2.5',
                    modelLifecycle: { status: 'ACTIVE' },
                },
                {
                    modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
                    modelName: 'Claude Sonnet 4.5',
                    modelLifecycle: { status: 'ACTIVE' },
                },
            ],
        });
        expect(models.map((m) => m.id)).toEqual(
            expect.arrayContaining([
                'moonshotai.kimi-k2.5',
                'anthropic.claude-sonnet-4-5-20250929-v1:0',
            ]),
        );
    });

    // Regression: reasoningKeyOf's regex required a geography prefix
    // (`us.anthropic....`), which ListInferenceProfiles always sent.
    // ListFoundationModels returns the BARE id (`anthropic....`, no prefix) —
    // without widening the regex, a live-listed Claude model would silently
    // lose its reasoning-capability badge even though the prefixed profile the
    // runtime actually calls has one.
    it('resolves reasoning caps for a BARE Claude id, same as the geography-prefixed one', () => {
        const [bare] = listing().parse({
            modelSummaries: [
                {
                    modelId: 'anthropic.claude-opus-4-1-20250805-v1:0',
                    modelName: 'Claude Opus 4.1',
                    modelLifecycle: { status: 'ACTIVE' },
                },
            ],
        });
        const [prefixed] = (listing().fallbackModels ?? []).filter(
            (m) => m.id === 'us.anthropic.claude-opus-4-1-20250805-v1:0',
        );
        expect(bare.supportsReasoning).toBe(true);
        expect(bare.supportsReasoning).toBe(prefixed?.supportsReasoning);
    });

    it('is permissive when modelLifecycle is absent (treats as ACTIVE)', () => {
        const models = listing().parse({
            modelSummaries: [
                { modelId: 'moonshotai.kimi-k2.5', modelName: 'Kimi K2.5' },
            ],
        });
        expect(models.map((m) => m.id)).toEqual(['moonshotai.kimi-k2.5']);
    });

    it('parse tolerates a malformed body', () => {
        expect(listing().parse({})).toEqual([]);
        expect(listing().parse(null)).toEqual([]);
    });

    it('carries a curated fallback that EXCLUDES the EOL Claude 3.5 Haiku', () => {
        const ids = (listing().fallbackModels ?? []).map((m) => m.id);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids).not.toContain(
            'us.anthropic.claude-3-5-haiku-20241022-v1:0',
        );
    });
});
