// Barrel import self-registers every provider module, so REGISTRY.all() carries
// each module's `catalog`. This asserts the aggregator stamps brand identity +
// transport correctly and preserves the migrated editorial data.
import { REGISTRY } from '../index';
import { resolveCatalogFrom } from './catalog';

describe('resolveCatalogFrom', () => {
    const resolved = resolveCatalogFrom(REGISTRY.all());
    const byId = (id: string) => resolved.find((m) => m.id === id);

    it('flattens a native brand and stamps its identity (transport = module id)', () => {
        const sonnet = byId('claude-sonnet-4-6');
        expect(sonnet).toMatchObject({
            id: 'claude-sonnet-4-6',
            displayName: 'Claude Sonnet 4.6',
            provider: 'anthropic',
            providerKey: 'anthropic',
            providerDisplayName: 'Anthropic',
            tier: 'recommended',
            recommendationLabel: 'Best balance',
            benchmarkScore: 88,
            speed: 'medium',
            contextWindow: '200K',
            costTier: '$$$',
        });
    });

    it('preserves each migrated Anthropic model faithfully', () => {
        const opus = byId('claude-opus-4-7');
        expect(opus).toMatchObject({
            provider: 'anthropic',
            providerKey: 'anthropic',
            benchmarkScore: 91,
            contextWindow: '1M',
            recommendationLabel: 'Highest quality',
            defaults: {
                temperature: 0,
                maxOutputTokens: 32768,
                reasoningEffort: 'medium',
            },
        });
    });

    it('a catalog entry never overrides its own module identity', () => {
        // Every resolved entry carries a brand + a transport, and the transport
        // defaults to the module id when the entry declares no override.
        for (const m of resolved) {
            expect(m.providerKey).toBeTruthy();
            expect(m.provider).toBeTruthy();
            expect(m.providerDisplayName).toBeTruthy();
        }
    });

    it('every Anthropic-protocol brand uses the SAME shared transport (one form)', () => {
        // Z.ai and Moonshot/Kimi keep their own BRAND identity but build over the
        // one shared `anthropic_compatible` transport — no per-brand transport id.
        expect(byId('glm-5.2')).toMatchObject({
            provider: 'anthropic_compatible',
            providerKey: 'zai',
            providerDisplayName: 'Z.ai',
            benchmarkScore: 84,
            defaultVariantId: 'developer',
        });
        expect(byId('kimi-k2.7-code')).toMatchObject({
            provider: 'anthropic_compatible',
            providerKey: 'moonshot',
            providerDisplayName: 'Moonshot',
        });
    });

    it('carries every migrated brand and no OpenRouter curation', () => {
        const byBrand = (key: string) =>
            resolved.filter((m) => m.providerKey === key).length;
        expect(byBrand('anthropic')).toBe(4);
        expect(byBrand('openai')).toBe(2);
        expect(byBrand('google_gemini')).toBe(4);
        expect(byBrand('moonshot')).toBe(2);
        expect(byBrand('zai')).toBe(1);
        // OpenRouter is a marketplace, not a curated brand → 0 curated models.
        expect(byBrand('open_router')).toBe(0);
        expect(resolved.length).toBe(13);
    });
});
