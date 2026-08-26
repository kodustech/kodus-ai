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

    it('builds the ListInferenceProfiles URL scoped to the user region', () => {
        const url = listing().url({
            awsBearerToken: 'ABSK-x',
            awsRegion: 'us-east-1',
        });
        expect(url).toBe(
            'https://bedrock.us-east-1.amazonaws.com/inference-profiles?maxResults=1000&typeEquals=SYSTEM_DEFINED',
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

    it('parses inferenceProfileSummaries → {id,name}, dropping non-ACTIVE', () => {
        const models = listing().parse({
            inferenceProfileSummaries: [
                {
                    inferenceProfileId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    inferenceProfileName: 'US Claude Sonnet 4.5',
                    status: 'ACTIVE',
                },
                {
                    inferenceProfileId: 'us.anthropic.dead-model-v1:0',
                    inferenceProfileName: 'Dead',
                    status: 'INACTIVE',
                },
            ],
        });
        expect(models.map((m) => m.id)).toEqual([
            'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        ]);
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
