import {
    analyzeCodeStructure,
    supportsCodeStructureAnalysis,
} from './analyze-code-structure';

describe('analyzeCodeStructure', () => {
    it.each(['types.d.ts', 'types.d.mts', 'types.d.cts', 'TYPES.D.MTS'])(
        'excludes declaration file %s without attempting code generation',
        (path) => {
            expect(supportsCodeStructureAnalysis(path)).toBe(false);
            expect(
                analyzeCodeStructure(
                    path,
                    'export declare function example(): void;',
                ),
            ).toBeNull();
        },
    );
    it.each(['source.ts', 'source.mts', 'source.cts'])(
        'still measures implementation file %s',
        (path) => {
            expect(
                analyzeCodeStructure(
                    path,
                    'export function example() { return true; }',
                ),
            ).toEqual({ functions: 1, functionsNeedingAttention: 0 });
        },
    );
    it('finds a deeply nested function without counting nested functions twice', () => {
        const result = analyzeCodeStructure(
            'src/service.ts',
            `function outer(a: boolean, b: boolean, c: boolean, d: boolean) {
                if (a) { if (b) { if (c) { if (d) { return true; } } } }
                const inner = () => 1;
                return inner();
            }`,
        );

        expect(result).toEqual({
            functions: 2,
            functionsNeedingAttention: 1,
        });
    });

    it('keeps unsupported and invalid files unknown', () => {
        expect(
            analyzeCodeStructure('src/service.py', 'def run(): pass'),
        ).toBeNull();
        expect(
            analyzeCodeStructure('src/service.ts', 'function broken('),
        ).toBeNull();
    });
});
