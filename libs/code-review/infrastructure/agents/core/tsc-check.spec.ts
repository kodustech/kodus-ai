import type { CommandResult } from '@libs/agent-harness/domain/contracts/command-runner.contract';
import type { FinderSuggestion } from './finder.agent';
import { tscCheck } from './tsc-check';

function finding(over: Partial<FinderSuggestion>): FinderSuggestion {
    return {
        relevantFile: 'src/x.ts',
        suggestionContent: 'bug',
        existingCode: '',
        improvedCode: '',
        relevantLinesStart: 12,
        ...over,
    };
}

const result = (stdout: string, exitCode = 2): CommandResult => ({
    exitCode,
    stdout,
    stderr: '',
});

describe('tscCheck.command / cacheKey', () => {
    it('runs a project-level tsc for TS/TSX findings', () => {
        expect(tscCheck.command(finding({ relevantFile: 'src/x.ts' }))).toContain(
            'tsc --noEmit',
        );
        expect(tscCheck.command(finding({ relevantFile: 'src/x.tsx' }))).toContain(
            'tsc --noEmit',
        );
    });

    it('skips non-TS and declaration files (→ fail open, no command)', () => {
        expect(tscCheck.command(finding({ relevantFile: 'src/x.js' }))).toBeNull();
        expect(tscCheck.command(finding({ relevantFile: 'src/x.py' }))).toBeNull();
        expect(tscCheck.command(finding({ relevantFile: 'types/x.d.ts' }))).toBeNull();
    });

    it('shares ONE tsc run across all TS findings (constant cacheKey)', () => {
        expect(tscCheck.cacheKey!(finding({ relevantFile: 'a.ts' }))).toBe('tsc:project');
        expect(tscCheck.cacheKey!(finding({ relevantFile: 'b.ts' }))).toBe('tsc:project');
        expect(tscCheck.cacheKey!(finding({ relevantFile: 'c.js' }))).toBeNull();
    });
});

describe('tscCheck.interpret', () => {
    it('corroborates (keep, high) when tsc flags the finding line — (LINE,COL) format', () => {
        const r = result(
            "src/x.ts(12,5): error TS2322: Type 'string' is not assignable to 'number'.",
        );
        const v = tscCheck.interpret(finding({ relevantLinesStart: 12 }), r);

        expect(v.keep).toBe(true);
        expect(v.confidence).toBe('high'); // decisive → CompositeVerifier skips the LLM
        expect(v.dimensions).toEqual([
            { name: 'tsc', pass: false, note: 'error at src/x.ts:12' },
        ]);
    });

    it('corroborates on the file:LINE:COL diagnostic format too', () => {
        const r = result('src/x.ts:12:5 - error TS2322: bad type');
        const v = tscCheck.interpret(finding({ relevantLinesStart: 12 }), r);
        expect(v.keep).toBe(true);
        expect(v.confidence).toBe('high');
    });

    it('defers to the LLM (low confidence) when tsc errors elsewhere, not at the line', () => {
        const r = result('src/x.ts(99,1): error TS2322: somewhere else');
        const v = tscCheck.interpret(finding({ relevantLinesStart: 12 }), r);

        expect(v.keep).toBe(true); // never drops on absence
        expect(v.confidence).toBe('low'); // → falls through to the LLM
    });

    it('defers when tsc is clean (a clean file does not refute a logic finding)', () => {
        const v = tscCheck.interpret(finding({ relevantLinesStart: 12 }), result('', 0));
        expect(v.keep).toBe(true);
        expect(v.confidence).toBe('low');
    });

    it('defers when the finding has no line anchor', () => {
        const r = result('src/x.ts(12,5): error TS2322: bad');
        const v = tscCheck.interpret(finding({ relevantLinesStart: undefined }), r);
        expect(v.confidence).toBe('low');
    });
});
