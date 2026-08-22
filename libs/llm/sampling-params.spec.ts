import { resolveByokTemperature } from './sampling-params';

/**
 * Characterization: temperature resolution now routes through the provider
 * module contract (`supportsSamplingParams`) instead of an inline anthropic
 * import. These lock the exact behavior the previous `resolveByokTemperature`
 * had — in particular the anthropic_compatible (Kimi) guard that a naive
 * model-name-only check would regress.
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

    it('never withholds from anthropic_compatible (Kimi requires temperature)', () => {
        // The regression guard: keyed on the provider id, not the model name —
        // a kimi model would never match the claude-* pattern and get wrongly
        // withheld if this routed through capabilities(model) alone.
        expect(
            resolveByokTemperature({
                provider: 'anthropic_compatible',
                model: 'kimi-k2.7-code',
                temperature: 1,
            }),
        ).toBe(1);
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
