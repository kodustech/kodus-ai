jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { captureByokWire } from './testing/byok-wire';
import './providers';

/**
 * #2036 QA: MiniMax M3.1 on the Anthropic endpoint had no level to pick, and
 * a level saved through the API never reached the wire, so every call ran at
 * the model's default (`max`). MiniMax documents the contract
 * (platform.minimax.io, Anthropic SDK): thinking always on, "if `type` is
 * sent it must be `adaptive`", `disabled` and effort `none` are 400s, and
 * `output_config.effort` takes low, medium, high, xhigh or max.
 */
describe('MiniMax M3.1 reasoning level on the Anthropic endpoint', () => {
    const slot = (reasoningEffort?: string) =>
        ({
            provider: 'anthropic_compatible',
            model: 'MiniMax-M3.1-Flash',
            baseURL: 'https://api.minimax.io/anthropic',
            apiKey: 'k',
            ...(reasoningEffort ? { reasoningEffort } : {}),
        }) as any;

    it.each(['low', 'medium', 'high'])(
        'sends %s as adaptive thinking with output_config.effort',
        async (effort) => {
            const wire = await captureByokWire(slot(effort));
            expect(wire.body?.thinking).toEqual({ type: 'adaptive' });
            expect(wire.body?.output_config).toEqual({ effort });
        },
    );

    it.each([undefined, 'none'])(
        'sends neither a disable nor an effort with %p saved: the model runs at its default',
        async (effort) => {
            const wire = await captureByokWire(slot(effort));
            expect(wire.body?.thinking).toBeUndefined();
            expect(wire.body?.output_config?.effort).toBeUndefined();
        },
    );

    it('leaves plain MiniMax-M3 without a level: it has none', async () => {
        const wire = await captureByokWire({
            ...slot('high'),
            model: 'MiniMax-M3',
        });
        expect(wire.body?.output_config?.effort).toBeUndefined();
        expect(wire.body?.thinking?.type).not.toBe('disabled');
    });
});
