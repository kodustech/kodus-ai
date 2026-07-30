import {
    fileWasInvestigated,
    normalizePath,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';

// Findings are typed with relevantFile: string, but LLM output (observed
// with kimi-k2.7 on a customer instance) sometimes omits the field. An
// undefined reaching normalizePath crashed the entire finder run — the
// review completed "with warnings" and the agent's work was dropped.
describe('finder path guards', () => {
    it('normalizePath tolerates undefined/null/non-string input', () => {
        expect(normalizePath(undefined as any)).toBe('');
        expect(normalizePath(null as any)).toBe('');
        expect(normalizePath('' as any)).toBe('');
        expect(normalizePath(42 as any)).toBe('');
    });

    it('normalizePath still normalizes real paths', () => {
        expect(normalizePath('.\\src\\App.TS')).toBe('src/app.ts');
        expect(normalizePath('./lib/x.ts')).toBe('lib/x.ts');
    });

    it('a finding without a file never counts as investigated', () => {
        const investigated = new Set(['src/app.ts']);
        expect(fileWasInvestigated(investigated, undefined as any)).toBe(
            false,
        );
        expect(fileWasInvestigated(investigated, '' as any)).toBe(false);
    });

    it('matching still works for real files', () => {
        const investigated = new Set(['src/app.ts']);
        expect(fileWasInvestigated(investigated, 'src/app.ts')).toBe(true);
        expect(fileWasInvestigated(investigated, 'app.ts')).toBe(true);
        expect(fileWasInvestigated(investigated, 'other.ts')).toBe(false);
    });
});
