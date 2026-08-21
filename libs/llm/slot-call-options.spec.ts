import { resolveSlotCallOptions } from './slot-call-options';

describe('resolveSlotCallOptions — the single slot→call-tuning mapping', () => {
    it('passes through a configured temperature + maxOutputTokens', () => {
        expect(
            resolveSlotCallOptions({
                provider: 'openai',
                temperature: 0.3,
                maxOutputTokens: 5000,
            } as any),
        ).toEqual({ temperature: 0.3, maxOutputTokens: 5000 });
    });

    it('omits unset knobs so the model default applies', () => {
        expect(resolveSlotCallOptions({ provider: 'openai' } as any)).toEqual(
            {},
        );
        expect(resolveSlotCallOptions(null)).toEqual({});
        expect(resolveSlotCallOptions(undefined)).toEqual({});
    });

    it('keeps temperature 0 (deterministic) but drops non-positive maxOutputTokens', () => {
        expect(
            resolveSlotCallOptions({
                provider: 'openai',
                temperature: 0,
                maxOutputTokens: 0,
            } as any),
        ).toEqual({ temperature: 0 });
    });
});
