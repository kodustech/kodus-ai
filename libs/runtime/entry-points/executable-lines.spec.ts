import { executableChangedLines } from './executable-lines';

// The new-side lines of changed executable code the cell measures: added code
// rows of JS/TS files, never comments, blank lines, tests or documentation.

const added = (lines: string[], start = 1) => [`@@ -0,0 +${start},${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');

describe('executableChangedLines', () => {
    it('keeps the added code rows of a JS/TS file, not its comments or blank lines', () => {
        const content = '// header\nconst a = 1;\n\nexport function f() {\n  return a;\n}';
        const patch = added(content.split('\n'));
        expect(executableChangedLines([{ path: 'src/a.ts', patch, content }])).toEqual([{ path: 'src/a.ts', lines: [2, 4, 5, 6] }]);
    });

    it('leaves removed rows out: only lines that exist on the new side can run', () => {
        const content = 'const x = 2;\nconst y = 1;';
        const patch = '@@ -1,3 +1,2 @@\n-const x = 1;\n-const gone = 3;\n+const x = 2;\n const y = 1;';
        expect(executableChangedLines([{ path: 'a.js', patch, content }])).toEqual([{ path: 'a.js', lines: [1] }]);
    });

    it('skips tests, documentation, other languages and the truncation marker', () => {
        const code = 'const a = 1;';
        const files = ['src/a.spec.ts', 'src/__tests__/b.ts', 'README.md', 'main.go', 'app.py', '.kodus-runtime/diff-truncated'].map((path) => ({
            path,
            patch: added([code]),
            content: code,
        }));
        expect(executableChangedLines(files)).toEqual([]);
    });

    it('drops a file whose change is only comments', () => {
        const content = '// one\n/* two */\nconst a = 1;';
        const patch = '@@ -1,1 +1,3 @@\n+// one\n+/* two */\n const a = 1;';
        expect(executableChangedLines([{ path: 'a.ts', patch, content }])).toEqual([]);
    });

    it('without the new content, falls back to added rows that are not blank or a comment', () => {
        const patch = added(['// c', '', 'const a = 1;', ' * doc', 'f();']);
        expect(executableChangedLines([{ path: 'a.ts', patch }])).toEqual([{ path: 'a.ts', lines: [3, 5] }]);
    });

    it('is bounded in files and lines per file', () => {
        const content = Array.from({ length: 30 }, (_, i) => `const a${i} = ${i};`).join('\n');
        const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.ts`, patch: added(content.split('\n')), content }));
        const out = executableChangedLines(files, { maxFiles: 2, maxLinesPerFile: 10 });
        expect(out.map((f) => f.path)).toEqual(['f0.ts', 'f1.ts']);
        expect(out[0].lines).toHaveLength(10);
    });
});
