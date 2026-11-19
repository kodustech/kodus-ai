const warn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: (...a: unknown[]) => warn(...a),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

import { buildAgentTools } from './agent-tools.factory';
import { cutLongLines, MAX_TOOL_LINE_CHARS } from './long-lines';

/**
 * A match inside a minified bundle is one line of hundreds of KB. Handed to
 * the agent, it froze workers twice over: the secret-file filter, then the
 * context compressor tokenizing it on every step (2026-11-19). No line the
 * search tools return is longer than MAX_TOOL_LINE_CHARS.
 */
describe('agent tools — long lines in search output', () => {
    const huge = 'x'.repeat(300_000);
    const rcReturning = (stdout: string) => ({
        grep: async () => stdout,
        read: async () => '',
        listDir: async () => '',
        exec: async () => ({ stdout, stderr: '', exitCode: 0 }),
    });

    describe('cutLongLines', () => {
        it('leaves output with no long line untouched (same string)', () => {
            const out = 'src/a.ts:1:const a = 1;\nsrc/a.ts-2-const b = 2;';
            const r = cutLongLines(out);
            expect(r.text).toBe(out);
            expect(r.cut).toBe(0);
            expect(r.longest).toBe('src/a.ts:1:const a = 1;'.length);
        });

        it.each([
            ['exactly the limit', MAX_TOOL_LINE_CHARS, 0],
            ['one over the limit', MAX_TOOL_LINE_CHARS + 1, 1],
        ])('treats a line of %s', (_l, length, cut) => {
            const line = 'a'.repeat(length);
            const r = cutLongLines(line);
            expect(r.cut).toBe(cut);
            expect(r.longest).toBe(length);
            if (!cut) expect(r.text).toBe(line);
        });

        it('keeps the start of a cut line, its path and line number first, and says how much was dropped', () => {
            const line = `dist/app.min.js:1:${huge}`;
            const r = cutLongLines(`src/a.ts:3:ok\n${line}\nsrc/b.ts:9:ok`);
            const [first, second, third] = r.text.split('\n');
            expect(first).toBe('src/a.ts:3:ok');
            expect(third).toBe('src/b.ts:9:ok');
            expect(second.startsWith(`dist/app.min.js:1:xxx`)).toBe(true);
            expect(second).toContain(
                `[${line.length - MAX_TOOL_LINE_CHARS} more characters on this line not shown]`,
            );
            expect(r.cut).toBe(1);
            expect(r.longest).toBe(line.length);
        });

        it('never ends a cut line on half of a surrogate pair', () => {
            // An emoji whose first half is the last kept character.
            const line =
                'a'.repeat(MAX_TOOL_LINE_CHARS - 1) +
                '\u{1F600}' +
                'b'.repeat(50);
            const r = cutLongLines(line);
            expect(r.cut).toBe(1);
            expect(r.text.isWellFormed()).toBe(true);
            expect(r.text.startsWith('a'.repeat(MAX_TOOL_LINE_CHARS - 1))).toBe(
                true,
            );
        });

        it('names the files of the cut lines, each once', () => {
            const r = cutLongLines(
                [
                    `dist/a.min.js:1:${huge}`,
                    `dist/a.min.js-2-${huge}`,
                    `[acme/lib] out/b.json:9:${huge}`,
                    `no-line-number-${huge}`,
                ].join('\n'),
            );
            expect(r.files).toEqual(['dist/a.min.js', '[acme/lib] out/b.json']);
        });

        it('keeps empty lines and a trailing newline', () => {
            const r = cutLongLines(`a\n\n${'b'.repeat(5_000)}\n`);
            const lines = r.text.split('\n');
            expect(lines).toHaveLength(4);
            expect(lines[1]).toBe('');
            expect(lines[3]).toBe('');
        });

        it('answers fast on many huge lines', () => {
            const out = Array.from({ length: 20 }, () => huge).join('\n');
            const started = Date.now();
            const r = cutLongLines(out);
            expect(Date.now() - started).toBeLessThan(500);
            expect(r.cut).toBe(20);
            expect(r.text.length).toBeLessThan(20 * (MAX_TOOL_LINE_CHARS + 80));
        });
    });

    it.each([
        ['the sandbox rg', 'exec'],
        ['the provider grep', 'grep'],
    ])('cuts a huge line from %s before the agent gets it', async (_l, via) => {
        const stdout = `src/a.ts:1:const a = 1;\ndist/app.min.js:1:${huge}`;
        const remote: any = rcReturning(stdout);
        if (via === 'grep') delete remote.exec;
        const out: string = await buildAgentTools(remote).grep.execute({
            pattern: 'x',
        });
        expect(out).toContain('src/a.ts:1:const a = 1;');
        for (const line of out.split('\n')) {
            expect(line.length).toBeLessThanOrEqual(MAX_TOOL_LINE_CHARS + 80);
        }
        expect(out).toContain('more characters on this line not shown');
    });

    it('names the reviewed repository and the search in the warning of a cut', async () => {
        warn.mockClear();
        const stdout = `dist/app.min.js:1:${huge}`;
        await buildAgentTools(
            rcReturning(stdout) as any,
            undefined,
            'acme/app',
        ).grep.execute({ pattern: 'needle', path: 'dist' });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    tool: 'grep',
                    files: ['dist/app.min.js'],
                    path: 'dist',
                    repository: 'acme/app',
                    linesCut: 1,
                }),
            }),
        );
        // The agent's pattern can quote a secret: never logged.
        expect(JSON.stringify(warn.mock.calls)).not.toContain('needle');
    });

    it('still drops a secret file line before cutting, even a huge one', async () => {
        const stdout = `certs/server.pem:1:${huge}\nsrc/a.ts:1:const a = 1;`;
        const out: string = await buildAgentTools(
            rcReturning(stdout) as any,
        ).grep.execute({ pattern: 'x' });
        expect(out).toBe('src/a.ts:1:const a = 1;');
    });

    it('returns a normal search result exactly as before', async () => {
        const stdout = 'src/a.ts:1:const a = 1;\n--\nsrc/b.ts:4:const b = 2;';
        const out = await buildAgentTools(
            rcReturning(stdout) as any,
        ).grep.execute({ pattern: 'const' });
        expect(out).toBe(stdout);
    });
});
