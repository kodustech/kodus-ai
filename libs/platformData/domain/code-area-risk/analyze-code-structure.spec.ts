import { analyzeCodeStructure } from './analyze-code-structure';

describe('analyzeCodeStructure', () => {
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
