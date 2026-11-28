import { analyzeDiff } from './diff-analysis';
import { executableChangedLines } from './executable-lines';
import { extractEntryPoints } from './extract';
import { noRuntimeEffectOf } from './no-effect';

// One pass over a Run's diff gives what the three parser readers give one by
// one, parses each side of each file once, and gives the event loop back as
// it goes (p1-performance P12: five synchronous passes held the
// runtime-worker for up to a minute on a large diff).

/** A file whose middle line changes, with the head content and a patch against it. */
function changed(path: string, base: string[], at: number, line: string) {
    const head = [...base];
    head[at] = line;
    const patch = `@@ -${at},3 +${at},3 @@\n ${base[at - 1]}\n-${base[at]}\n+${head[at]}\n ${base[at + 1]}`;
    return { path, patch, content: head.join('\n') };
}

const express = (k: number, routes: number) => {
    const lines = ["import express from 'express';", 'const router = express.Router();'];
    for (let i = 0; i < routes; i++) lines.push(`router.get('/r${k}_${i}', async (req, res) => {`, `  const x = await svc.find({ id: req.params.id, limit: ${i} });`, '  return res.json(x);', '});');
    lines.push('export default router;');
    return lines;
};

const nest = [
    "import { Controller, Get, Post } from '@nestjs/common';",
    "@Controller('orders')",
    'export class OrdersController {',
    "    @Get(':id')",
    '    one() {',
    '        return 1;',
    '    }',
    '    @Post()',
    '    create() {',
    '        return 2;',
    '    }',
    '}',
];

const diffs = {
    'routes, a comment, a Nest handler, docs, a lockfile, a test and Go': [
        changed('src/routes/a.ts', express(1, 6), 8, '  const x = await svc.find({ id: req.params.id, max: 1 });'),
        changed('src/routes/b.ts', express(2, 6), 8, '  // the lookup by id'),
        changed('src/orders/orders.controller.ts', nest, 9, '        return 3;'),
        { path: 'README.md', patch: '@@ -1,1 +1,1 @@\n-a\n+b', content: 'b' },
        { path: 'package-lock.json', patch: '@@ -1,1 +1,1 @@\n-1\n+2', content: '2' },
        changed('src/orders/orders.spec.ts', ['a', 'it("x", () => {', '  expect(1).toBe(1);', '});', 'b'], 2, '  expect(2).toBe(2);'),
        changed('cmd/main.go', ['package main', '', 'func main() {', '\tprintln("a")', '}'], 3, '\tprintln("b")'),
    ],
    'only comments and layout': [
        changed('src/a.ts', ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'], 1, 'const b = 2; // two'),
        changed('app/main.py', ['import os', 'x = 1', 'y = 2', 'z = 3'], 1, 'x = 1  # one'),
        { path: 'CHANGELOG.md', patch: '@@ -1,1 +1,1 @@\n-a\n+b', content: 'b' },
    ],
    'a cut diff': [changed('src/a.ts', ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'], 1, 'const b = 3;'), { path: '.kodus-runtime/diff-truncated', patch: '' }],
};

describe('analyzeDiff', () => {
    it.each(Object.entries(diffs))('gives what noRuntimeEffectOf, extractEntryPoints and executableChangedLines give: %s', async (_label, files) => {
        const truncated = files.some((f) => f.path === '.kodus-runtime/diff-truncated');
        const a = await analyzeDiff(files, { truncated });
        expect(a.noRuntimeEffect).toEqual(noRuntimeEffectOf(files, { truncated }));
        expect(a.entryPoints).toEqual(extractEntryPoints(files));
        expect(a.executable).toEqual(executableChangedLines(files));
    });

    it('gives what the readers give for the files a recipe names', async () => {
        const files = [changed('.kodus/workspace.yaml', ['a', 'b', 'c', 'd'], 1, 'x'), ...diffs['routes, a comment, a Nest handler, docs, a lockfile, a test and Go']];
        const recipe = ['.kodus/workspace.yaml'];
        const a = await analyzeDiff(files, { recipe });
        expect(a.entryPoints).toEqual(extractEntryPoints(files, { recipe }));
        expect(a.noRuntimeEffect).toEqual(noRuntimeEffectOf(files, { recipe }));
    });

    it('parses each side of each judged file once: the text parsed is the two sides of each code file', async () => {
        const files = diffs['routes, a comment, a Nest handler, docs, a lockfile, a test and Go'];
        const a = await analyzeDiff(files);
        // README and the lockfile are not parsed; every other file is parsed on both sides, once each.
        const code = files.filter((f) => /\.(ts|go)$/.test(f.path));
        const baseChars = (f: (typeof code)[number]) => f.content.length - f.patch.split('\n')[3].length + f.patch.split('\n')[2].length;
        expect(a.parsedChars).toBe(code.reduce((n, f) => n + f.content.length + baseChars(f), 0));
        expect(a.overBudget).toEqual([]);
    });

    it('gives the event loop back between files and inside a large file', async () => {
        const files = Array.from({ length: 3 }, (_, k) => changed(`src/routes/r${k}.ts`, express(k, 200), 402, '  const x = await svc.find({ id: req.params.id, max: 1 });'));
        let turns = 0;
        let done = false;
        const tick = () => {
            turns++;
            if (!done) setImmediate(tick);
        };
        setImmediate(tick);
        await analyzeDiff(files);
        done = true;
        // At least one turn per side of each file, and more inside each walk of a 200-route file.
        expect(turns).toBeGreaterThan(files.length * 3);
    }, 20_000);

    it('reads a file past the parse budget the conservative way: its changed rows are code', async () => {
        const files = diffs['only comments and layout'];
        expect((await analyzeDiff(files)).noRuntimeEffect).toBeDefined();
        const bounded = await analyzeDiff(files, { budgetChars: 10 });
        expect(bounded.noRuntimeEffect).toBeUndefined();
        expect(bounded.overBudget).toEqual(expect.arrayContaining(['src/a.ts']));
        // The comment row now counts as code, so the file is an entry point instead of no change.
        expect(bounded.entryPoints.map((e) => e.id)).toContain('unmapped:src/a.ts');
    });
});
