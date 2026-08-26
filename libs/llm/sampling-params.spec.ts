import { resolveByokTemperature } from './sampling-params';

/**
 * Characterization: temperature resolution routes through the provider module
 * contract (`temperaturePolicy`) instead of an inline anthropic import. These lock
 * the three policy outcomes — unsupported (withheld), fixed (pinned over the stored
 * value), adjustable (stored value stands) — including the anthropic_compatible
 * (Kimi) cases a naive model-name-only check would regress.
 */
describe('resolveByokTemperature (via provider registry)', () => {
    it('withholds temperature from real Anthropic 4.7+ (400 otherwise)', () => {
        expect(
            resolveByokTemperature({
                provider: 'anthropic',
                model: 'claude-opus-4-8',
                temperature: 0.7,
            }),
        ).toBeUndefined();
        expect(
            resolveByokTemperature({
                provider: 'anthropic',
                model: 'claude-opus-5',
                temperature: 0.2,
            }),
        ).toBeUndefined();
    });

    it('keeps temperature for Anthropic models that still accept it', () => {
        expect(
            resolveByokTemperature({
                provider: 'anthropic',
                model: 'claude-sonnet-4-5',
                temperature: 0.3,
            }),
        ).toBe(0.3);
    });

    it('PINS always-thinking Kimi (k2.7-code) to 1, OVER whatever is stored', () => {
        // k2.7-code reasons unconditionally; the Anthropic protocol requires
        // temperature 1 while thinking. So a stale stored 0 (or 0.7) must resolve
        // to 1 — the model can't run right at anything else. Regression for the
        // "Temp: 0 saved on a Kimi model" incident.
        for (const stored of [0, 0.7, undefined, 1]) {
            expect(
                resolveByokTemperature({
                    provider: 'anthropic_compatible',
                    model: 'kimi-k2.7-code',
                    temperature: stored,
                }),
            ).toBe(1);
        }
        // Same over the brand id (moonshot), not just the raw transport id.
        expect(
            resolveByokTemperature({
                provider: 'moonshot',
                model: 'kimi-k2.7-code',
                temperature: 0,
            }),
        ).toBe(1);
    });

    it('does NOT pin disable-able Kimi (k2.6) — keeps the stored temperature', () => {
        expect(
            resolveByokTemperature({
                provider: 'anthropic_compatible',
                model: 'kimi-k2.6',
                temperature: 0.3,
            }),
        ).toBe(0.3);
    });

    it('keeps temperature for non-anthropic providers', () => {
        expect(
            resolveByokTemperature({
                provider: 'openai',
                model: 'gpt-5',
                temperature: 0.5,
            }),
        ).toBe(0.5);
    });

    it('returns undefined when nothing is configured, keeps 0', () => {
        expect(resolveByokTemperature(undefined)).toBeUndefined();
        expect(
            resolveByokTemperature({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
        ).toBeUndefined();
        // 0 is a real (deterministic) value, not "unset".
        expect(
            resolveByokTemperature({
                provider: 'openai',
                model: 'gpt-5',
                temperature: 0,
            }),
        ).toBe(0);
    });

    it('defaults to keeping temperature for an unregistered provider', () => {
        expect(
            resolveByokTemperature({
                provider: 'some_unregistered_provider',
                model: 'whatever',
                temperature: 0.9,
            }),
        ).toBe(0.9);
    });
});
