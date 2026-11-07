import {
    APPLIED_IMPLEMENTATION_STATUSES,
    isImplementationApplied,
    normalizeImplementationStatus,
    raisesImplementationStatus,
    resolvesSuggestionThread,
    statusesAtOrAbove,
} from './implementation-status';
import { ImplementationStatus } from './enums/implementationStatus.enum';

describe('implementation status', () => {
    describe('normalizeImplementationStatus', () => {
        it.each([
            ['implemented', ImplementationStatus.IMPLEMENTED],
            ['IMPLEMENTED', ImplementationStatus.IMPLEMENTED],
            [' Implemented ', ImplementationStatus.IMPLEMENTED],
            [
                'partially_implemented',
                ImplementationStatus.PARTIALLY_IMPLEMENTED,
            ],
            [
                'PARTIALLY_IMPLEMENTED',
                ImplementationStatus.PARTIALLY_IMPLEMENTED,
            ],
            [
                'partially implemented',
                ImplementationStatus.PARTIALLY_IMPLEMENTED,
            ],
            [
                'partially-implemented',
                ImplementationStatus.PARTIALLY_IMPLEMENTED,
            ],
            ['not_implemented', ImplementationStatus.NOT_IMPLEMENTED],
            ['not implemented', ImplementationStatus.NOT_IMPLEMENTED],
            ['NOT_IMPLEMENTED', ImplementationStatus.NOT_IMPLEMENTED],
        ])('reads %j as %s', (raw, expected) => {
            expect(normalizeImplementationStatus(raw)).toBe(expected);
        });

        it.each([
            null,
            undefined,
            '',
            'yes',
            'The patch implements the suggestion.',
            'constructor',
            'toString',
            42,
            { default: 'implemented' },
        ])('rejects %j', (raw) => {
            expect(normalizeImplementationStatus(raw)).toBeNull();
        });
    });

    it('counts implemented and partial as applied, as the rate does', () => {
        expect(APPLIED_IMPLEMENTATION_STATUSES).toEqual([
            ImplementationStatus.IMPLEMENTED,
            ImplementationStatus.PARTIALLY_IMPLEMENTED,
        ]);
        expect(isImplementationApplied('implemented')).toBe(true);
        expect(isImplementationApplied('partially_implemented')).toBe(true);
        expect(isImplementationApplied('not_implemented')).toBe(false);
        expect(isImplementationApplied('IMPLEMENTED')).toBe(false);
        expect(isImplementationApplied(undefined)).toBe(false);
    });

    it('resolves a thread only for a suggestion fully implemented', () => {
        expect(resolvesSuggestionThread('implemented')).toBe(true);
        expect(resolvesSuggestionThread('partially_implemented')).toBe(false);
        expect(resolvesSuggestionThread('not_implemented')).toBe(false);
        expect(resolvesSuggestionThread(null)).toBe(false);
        expect(resolvesSuggestionThread('IMPLEMENTED')).toBe(false);
        expect(resolvesSuggestionThread('a sentence')).toBe(false);
    });

    describe('raisesImplementationStatus', () => {
        it.each([
            ['not_implemented', 'partially_implemented', true],
            ['not_implemented', 'implemented', true],
            ['partially_implemented', 'implemented', true],
            ['partially_implemented', 'partially_implemented', false],
            ['partially_implemented', 'not_implemented', false],
            ['implemented', 'partially_implemented', false],
            ['implemented', 'not_implemented', false],
            ['not_implemented', 'not_implemented', false],
            // A missing or invalid stored value ranks below every verdict.
            [undefined, 'not_implemented', true],
            ['a sentence', 'not_implemented', true],
            // A legacy spelling is read as the status it spells.
            ['IMPLEMENTED', 'not_implemented', false],
            ['Partially Implemented', 'implemented', true],
        ])('from %j to %s: %s', (stored, verdict, raises) => {
            expect(
                raisesImplementationStatus(
                    stored,
                    verdict as ImplementationStatus,
                ),
            ).toBe(raises);
        });
    });

    it('lists the statuses a verdict must not overwrite', () => {
        expect(
            statusesAtOrAbove(ImplementationStatus.PARTIALLY_IMPLEMENTED),
        ).toEqual([
            ImplementationStatus.PARTIALLY_IMPLEMENTED,
            ImplementationStatus.IMPLEMENTED,
        ]);
        expect(statusesAtOrAbove(ImplementationStatus.NOT_IMPLEMENTED)).toEqual(
            [
                ImplementationStatus.NOT_IMPLEMENTED,
                ImplementationStatus.PARTIALLY_IMPLEMENTED,
                ImplementationStatus.IMPLEMENTED,
            ],
        );
    });
});
