import { modelInputBytes } from '../application/model-input-bytes';
it('uses a conservative UTF8/JSON upper bound for Unicode, escaped text and unpaired surrogate code units', () => {
    for (const value of [
        '中😀',
        '\uD800',
        '\uDC00',
        '\u0000\\"',
        { content: '中😀', tool: { input: 'values' } },
    ]) {
        expect(modelInputBytes(value)).toBeGreaterThanOrEqual(
            Buffer.byteLength(JSON.stringify(value), 'utf8') + 1024,
        );
    }
    expect(() => modelInputBytes('\uD800', 1029)).toThrow();
});
it('refuses oversized/cyclic/exotic input without invoking a getter', () => {
    let read = false;
    expect(() =>
        modelInputBytes({
            get secret() {
                read = true;
                return 'not data';
            },
        }),
    ).toThrow();
    expect(read).toBe(false);
    const cycle: any = {};
    cycle.self = cycle;
    expect(() => modelInputBytes(cycle)).toThrow();
    expect(() => modelInputBytes({ text: 'x'.repeat(2000) }, 1500)).toThrow();
});
