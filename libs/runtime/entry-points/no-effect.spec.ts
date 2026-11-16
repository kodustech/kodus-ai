import { baseContentOf, codeChangedLines, isDocumentation, noEffectReason } from './no-effect';

// Whether a changed file can alter what runs, by its parser: a change that
// moves only comments, blank lines or layout has none (planner-eval.md fix 1).

const file = (path: string, base: string, head: string) => {
    // A one-hunk patch of the whole file: every base line removed, every head line added.
    const b = base.split('\n');
    const h = head.split('\n');
    const patch = [`@@ -1,${b.length} +1,${h.length} @@`, ...b.map((l) => `-${l}`), ...h.map((l) => `+${l}`)].join('\n');
    return { path, patch, content: head };
};

describe('baseContentOf', () => {
    it('rebuilds the base from the head and the patch', () => {
        const head = 'a\nB\nc\nd';
        expect(baseContentOf('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c', head)).toBe('a\nb\nc\nd');
    });

    it('rebuilds nothing when the patch and the content disagree', () => {
        expect(baseContentOf('@@ -1,2 +1,2 @@\n a\n+X', 'a\nY')).toBeUndefined();
    });
});

describe('noEffectReason', () => {
    it('a comment added to a TypeScript file has no effect', () => {
        expect(noEffectReason(file('src/a.ts', 'export const a = 1;', 'export const a = 1;\n\n// why'))).toBeDefined();
    });

    it('re-indenting TypeScript has no effect', () => {
        expect(noEffectReason(file('src/a.ts', 'function f() {\nreturn 1;\n}', 'function f() {\n    return 1;\n}'))).toBeDefined();
    });

    it('a changed literal is an effect', () => {
        expect(noEffectReason(file('src/a.ts', "const limit = '1024kb';", "const limit = '1mb';"))).toBeUndefined();
    });

    it('text that looks like a comment inside JSX is page text, an effect', () => {
        expect(noEffectReason(file('app/page.tsx', 'const P = () => <p>\n  a\n</p>;', 'const P = () => <p>\n  a\n  // b\n</p>;'))).toBeUndefined();
    });

    it('a comment marker inside a template literal is string content, an effect', () => {
        expect(noEffectReason(file('src/a.ts', 'const q = `\nselect 1\n`;', 'const q = `\nselect 1\n-- x\n`;'))).toBeUndefined();
        expect(noEffectReason(file('src/a.ts', 'const q = `\nselect 1\n`;', 'const q = `\nselect 1\n// x\n`;'))).toBeUndefined();
    });

    it('a line break that changes what JavaScript parses (return on its own line) is an effect', () => {
        expect(noEffectReason(file('src/a.js', 'function f() { return x; }', 'function f() { return\nx; }'))).toBeUndefined();
    });

    it('a file that does not parse is never judged', () => {
        expect(noEffectReason(file('src/a.ts', 'const a = 1;', 'const a = ;\n// x'))).toBeUndefined();
    });

    it('a Go comment has no effect; joining two Go lines does', () => {
        expect(noEffectReason(file('main.go', 'package main\nfunc f() {}', 'package main\n// note\nfunc f() {}'))).toBeDefined();
        expect(noEffectReason(file('main.go', 'package main\nvar a = 1\nvar b = 2', 'package main\nvar a = 1 var b = 2'))).toBeUndefined();
    });

    it('a Python comment has no effect; a change of indentation does', () => {
        expect(noEffectReason(file('app.py', 'def f():\n    return 1', '# note\ndef f():\n    return 1'))).toBeDefined();
        expect(noEffectReason(file('app.py', 'if a:\n    b()\nc()', 'if a:\n    b()\n    c()'))).toBeUndefined();
    });

    it('a README or a license is documentation; a Markdown file an app may serve is not', () => {
        expect(isDocumentation('README.md')).toBe(true);
        expect(isDocumentation('packages/x/CHANGELOG.md')).toBe(true);
        expect(isDocumentation('LICENSE')).toBe(true);
        expect(isDocumentation('.github/PULL_REQUEST_TEMPLATE.md')).toBe(true);
        expect(isDocumentation('content/blog/README.md')).toBe(false);
        expect(isDocumentation('docs/guide.md')).toBe(false);
    });

    it('a language with no parser here is never judged', () => {
        expect(noEffectReason(file('config.yaml', 'a: 1', 'a: 1\n# x'))).toBeUndefined();
    });
});

describe('codeChangedLines', () => {
    it('counts the rows that touch code, not the comments or blank lines around them', () => {
        const head = '// a\nconst x = 2;\n\nconst y = 1;';
        const patch = '@@ -1,3 +1,4 @@\n+// a\n-const x = 1;\n+const x = 2;\n \n const y = 1;';
        expect(codeChangedLines({ path: 'a.ts', patch, content: head })).toEqual([2]);
    });
});
