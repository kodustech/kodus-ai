import { isBetaFeaturesEnabled } from '@libs/feature-gate/domain/decision';

// #2425: the flag had two encodings in two places - the adapters took only
// `true`, the operator-facing checker also took `1` - so an install with
// BETA_FEATURES=1 read `pass` from the report and got every beta denied by the
// API. One parser, one answer.
describe('isBetaFeaturesEnabled', () => {
    it.each(['true', 'TRUE', 'True', ' true ', '\ttrue\n', '1', ' 1 '])(
        'counts %p as enabled',
        (value) => {
            expect(isBetaFeaturesEnabled(value)).toBe(true);
        },
    );

    it.each([
        undefined,
        null,
        '',
        '   ',
        'false',
        'FALSE',
        '0',
        'yes',
        'on',
        'tru',
    ])('counts %p as disabled', (value) => {
        expect(isBetaFeaturesEnabled(value as string | null | undefined)).toBe(
            false,
        );
    });
});
