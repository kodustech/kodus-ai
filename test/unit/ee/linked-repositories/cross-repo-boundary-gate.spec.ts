import { evaluateCrossRepoBoundaryGate } from '@libs/ee/linked-repositories';

function file(
    filename: string,
    patch: string,
    status: 'added' | 'modified' = 'modified',
) {
    return { filename, patch, status } as any;
}

describe('evaluateCrossRepoBoundaryGate', () => {
    it('stays off for empty / no files', () => {
        expect(evaluateCrossRepoBoundaryGate(undefined).activate).toBe(false);
        expect(evaluateCrossRepoBoundaryGate([]).activate).toBe(false);
    });

    it('stays off for pure whitespace / comment / import-only refactors', () => {
        const result = evaluateCrossRepoBoundaryGate([
            file(
                'src/utils/helpers.ts',
                [
                    '@@ -1,6 +1,6 @@',
                    " import { a } from './a';",
                    "-import { b } from './b';",
                    "+import { b } from './b';",
                    ' ',
                    ' // just a comment',
                    '+// another comment',
                    '+',
                    ' function foo() {',
                    '-  return 1;',
                    '+  return 1;',
                    ' }',
                ].join('\n'),
            ),
        ]);
        expect(result.activate).toBe(false);
        expect(result.reasons[0]).toContain('no boundary surface');
    });

    it('activates on added string literals (API field / status values)', () => {
        const result = evaluateCrossRepoBoundaryGate([
            file(
                'src/client.ts',
                [
                    '@@ -10,3 +10,4 @@',
                    ' const body = {',
                    "-  error: err.message,",
                    "+  message: err.message,",
                    "+  code: 'PAYMENT_FAILED',",
                    ' };',
                ].join('\n'),
            ),
        ]);
        expect(result.activate).toBe(true);
        expect(result.signals.some((s) => s.kind === 'string_literal')).toBe(
            true,
        );
        expect(result.signals.some((s) => s.kind === 'object_key')).toBe(true);
    });

    it('activates on export / type / enum surface', () => {
        const result = evaluateCrossRepoBoundaryGate([
            file(
                'src/types.ts',
                [
                    '@@ -1,2 +1,6 @@',
                    "+export enum PaymentStatus {",
                    "+  Pending = 'pending',",
                    "+  Paid = 'paid',",
                    '+}',
                ].join('\n'),
            ),
        ]);
        expect(result.activate).toBe(true);
        const kinds = new Set(result.signals.map((s) => s.kind));
        expect(kinds.has('export') || kinds.has('enum_or_type')).toBe(true);
        expect(kinds.has('string_literal')).toBe(true);
    });

    it('activates on contract-ish file paths even with sparse content', () => {
        const result = evaluateCrossRepoBoundaryGate([
            file(
                'src/api/dto/payment.dto.ts',
                [
                    '@@ -1,3 +1,4 @@',
                    ' export class PaymentDto {',
                    '+  amount: number;',
                    ' }',
                ].join('\n'),
            ),
        ]);
        expect(result.activate).toBe(true);
        expect(result.signals.some((s) => s.kind === 'contract_path')).toBe(
            true,
        );
    });

    it('activates on status/state assignments with constant values', () => {
        const result = evaluateCrossRepoBoundaryGate([
            file(
                'src/worker.ts',
                [
                    '@@ -20,2 +20,3 @@',
                    "+  status = 'standby';",
                    "   await save(status);",
                ].join('\n'),
            ),
        ]);
        expect(result.activate).toBe(true);
        expect(
            result.signals.some(
                (s) =>
                    s.kind === 'status_or_state' || s.kind === 'string_literal',
            ),
        ).toBe(true);
    });

    it('ignores deleted-only lines (no added boundary surface)', () => {
        const result = evaluateCrossRepoBoundaryGate([
            file(
                'src/legacy.ts',
                [
                    '@@ -1,4 +1,1 @@',
                    "-export const OLD = 'value';",
                    "-const status = 'gone';",
                    ' keep();',
                ].join('\n'),
            ),
        ]);
        // No + lines with boundary surface.
        expect(result.activate).toBe(false);
    });

    it('dedupes signal kinds per file', () => {
        const result = evaluateCrossRepoBoundaryGate([
            file(
                'src/a.ts',
                [
                    '@@ -1 +1,3 @@',
                    "+const a = 'one';",
                    "+const b = 'two';",
                    "+const c = 'three';",
                ].join('\n'),
            ),
        ]);
        const stringSignals = result.signals.filter(
            (s) => s.kind === 'string_literal',
        );
        expect(stringSignals).toHaveLength(1);
    });
});
