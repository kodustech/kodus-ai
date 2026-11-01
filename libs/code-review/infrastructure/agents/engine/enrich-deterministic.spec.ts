import {
    enrichDeterministic,
    languageFromPath,
} from '@libs/code-review/infrastructure/agents/engine/enrich-deterministic';

const file = ['line 1', 'line 2', 'line 3', 'line 4', ''].join('\n');

describe('enrichDeterministic', () => {
    it('cuts exactly the cited lines, uncapped', () => {
        const r = enrichDeterministic(
            {
                relevantFile: 'src/a.ts',
                relevantLinesStart: 2,
                relevantLinesEnd: 4,
            },
            file,
        );
        expect(r).toEqual({
            existingCode: 'line 2\nline 3\nline 4',
            language: 'typescript',
            anchorStatus: 'ok',
        });
    });

    it('reads a single line when the end is missing', () => {
        const r = enrichDeterministic(
            { relevantFile: 'a.rb', relevantLinesStart: 3 },
            file,
        );
        expect(r.existingCode).toBe('line 3');
    });

    it('cuts a range past the end of the file at the last line', () => {
        const r = enrichDeterministic(
            {
                relevantFile: 'a.go',
                relevantLinesStart: 3,
                relevantLinesEnd: 40,
            },
            file,
        );
        expect(r.existingCode).toBe('line 3\nline 4');
        expect(r.anchorStatus).toBe('ok');
    });

    it.each([
        [0, 2],
        [3, 2],
        [5, 6],
        [undefined, undefined],
    ])('flags the range %p-%p as invalid', (start, end) => {
        const r = enrichDeterministic(
            {
                relevantFile: 'a.py',
                relevantLinesStart: start,
                relevantLinesEnd: end,
            },
            file,
        );
        expect(r).toEqual({
            existingCode: '',
            language: 'python',
            anchorStatus: 'range-invalid',
        });
    });

    it('flags a file missing at the head', () => {
        expect(
            enrichDeterministic(
                {
                    relevantFile: 'a.java',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                },
                null,
            ),
        ).toEqual({
            existingCode: '',
            language: 'java',
            anchorStatus: 'file-missing',
        });
    });
});

describe('languageFromPath', () => {
    it.each([
        ['src/x.tsx', 'typescript'],
        ['app/models/user.rb', 'ruby'],
        ['app/views/x.html.erb', 'erb'],
        ['assets/s.scss', 'scss'],
        ['Makefile', ''],
        ['.env', ''],
        ['a.unknownext', ''],
        [undefined, ''],
    ])('%p -> %p', (path, lang) => {
        expect(languageFromPath(path)).toBe(lang);
    });
});
