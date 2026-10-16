import {
    effortFromOutputConfig,
    reasoningEffortFromWire,
} from './override-wire-spelling';

describe('reasoningEffortFromWire', () => {
    it('renames the API spelling to the adapter option', () => {
        expect(
            reasoningEffortFromWire({
                thinking: { type: 'enabled' },
                reasoning_effort: 'max',
            }),
        ).toEqual({ thinking: { type: 'enabled' }, reasoningEffort: 'max' });
    });

    it('keeps the adapter option when both are given', () => {
        const options = { reasoningEffort: 'high', reasoning_effort: 'max' };
        expect(reasoningEffortFromWire(options)).toBe(options);
    });

    it('leaves an override without the field untouched', () => {
        const options = { thinking: { type: 'enabled' } };
        expect(reasoningEffortFromWire(options)).toBe(options);
    });

    it('does not reach into nested objects', () => {
        // Inside `thinking` the key rides to the upstream as part of an opaque
        // object; moving it would change a field the adapter does pass through.
        const options = {
            thinking: { type: 'enabled', reasoning_effort: 'max' },
        };
        expect(reasoningEffortFromWire(options)).toBe(options);
    });
});

describe('effortFromOutputConfig', () => {
    it('moves the effort out and drops the emptied block', () => {
        expect(
            effortFromOutputConfig({
                thinking: { type: 'adaptive' },
                output_config: { effort: 'high' },
            }),
        ).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' });
    });

    it('keeps whatever else the block carried', () => {
        expect(
            effortFromOutputConfig({
                output_config: { effort: 'low', format: { type: 'json' } },
            }),
        ).toEqual({
            effort: 'low',
            output_config: { format: { type: 'json' } },
        });
    });

    it('keeps the adapter option when both are given', () => {
        const options = { effort: 'max', output_config: { effort: 'low' } };
        expect(effortFromOutputConfig(options)).toBe(options);
    });

    it.each([
        ['no block', { thinking: { type: 'adaptive' } }],
        ['a block without effort', { output_config: { format: {} } }],
        ['a block that is not an object', { output_config: 'high' }],
        ['a block that is a list', { output_config: ['high'] }],
    ])('leaves %s untouched', (_what, options) => {
        expect(effortFromOutputConfig(options as any)).toBe(options);
    });
});
