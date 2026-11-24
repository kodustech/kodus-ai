import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';
import { readWithinRootCommand } from '@libs/sandbox/infrastructure/providers/read-within-root';

import { buildAgentTools } from './agent-tools.factory';

/**
 * readFile's startLine and endLine come from the model and become a sed
 * address. sed's `w` writes a file and GNU sed's `e` runs a program, and in
 * the E2B shell a quote ends the address, so anything but a line number must
 * be refused before it reaches sed.
 */
describe('agent tools — readFile line range', () => {
    let dir: string;
    let outside: string;

    beforeEach(() => {
        dir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-line-range-')),
        );
        outside = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-line-range-out-')),
        );
        fs.writeFileSync(path.join(dir, 'a.ts'), 'one\ntwo\nthree\n');
        fs.writeFileSync(path.join(outside, 'secret.env'), 'TOKEN=hunter2\n');
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    const localTools = () =>
        buildAgentTools(
            (new LocalSandboxService({} as any) as any).buildRemoteCommands(
                dir,
            ),
        );

    it('reads a range the model sends as numbers or numeric strings', async () => {
        const tools = localTools();

        expect(
            await tools.readFile.execute({
                path: 'a.ts',
                startLine: 2,
                endLine: 2,
            }),
        ).toContain('2: two');
        expect(
            await tools.readFile.execute({
                path: 'a.ts',
                startLine: '2',
                endLine: '3',
            }),
        ).toContain('3: three');
    });

    it('reads the whole file when no line is given, or only zeros', async () => {
        const tools = localTools();
        for (const range of [
            {},
            { startLine: null, endLine: null },
            { startLine: '', endLine: '' },
            { startLine: 0, endLine: 0 },
            { start_line: 0, end_line: 0 },
        ]) {
            const out = await tools.readFile.execute({
                path: 'a.ts',
                ...range,
            });
            expect(out).toContain('1: one');
            expect(out).toContain('3: three');
        }
    });

    it('reads a numeric string with spaces or several digits as its number', async () => {
        fs.writeFileSync(
            path.join(dir, 'long.ts'),
            Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') +
                '\n',
        );
        const out = await localTools().readFile.execute({
            path: 'long.ts',
            startLine: ' 11 ',
            endLine: '12',
        });

        expect(out).toContain('11: line11');
        expect(out).toContain('12: line12');
        expect(out).not.toContain('line10');
    });

    // Number() reads `true` as 1 and `[5]` as 5: only a number or a numeric
    // string is a line.
    it('refuses a value that only Number() would read as a line', async () => {
        const tools = localTools();
        for (const value of [true, [2], ['2'], '2x', 'x2', '1 2', {}]) {
            expect(
                await tools.readFile.execute({
                    path: 'a.ts',
                    startLine: value,
                    endLine: 3,
                }),
            ).toMatch(/^Error: /);
        }
    });

    it('refuses a range that is not line numbers, without running sed', async () => {
        const written = path.join(outside, 'written');

        const out = await localTools().readFile.execute({
            path: 'a.ts',
            startLine: 1,
            endLine: `1p;w ${written}`,
        });

        expect(out).toMatch(/^Error: .*line/i);
        expect(fs.existsSync(written)).toBe(false);
    });

    it('refuses a fractional line or a negative end', async () => {
        const tools = localTools();
        for (const range of [
            { startLine: 1, endLine: 1.5 },
            { startLine: 1.5, endLine: 2 },
            { startLine: 1, endLine: -3 },
        ]) {
            expect(
                await tools.readFile.execute({ path: 'a.ts', ...range }),
            ).toMatch(/^Error: /);
        }
    });

    // The tool tells the model to read from grepLine-20, which goes below
    // line 1 near the top of a file.
    it('reads from the first line when the start is below 1', async () => {
        const out = await localTools().readFile.execute({
            path: 'a.ts',
            startLine: -15,
            endLine: 2,
        });

        expect(out).toContain('1: one');
        expect(out).toContain('2: two');
    });

    it('never builds an E2B read command around a value that is not a line number', () => {
        const injected = `1p' ${path.join(outside, 'secret.env')}; echo '`;

        expect(() =>
            readWithinRootCommand(
                path.join(dir, 'a.ts'),
                dir,
                1,
                injected as any,
            ),
        ).toThrow(/line/i);

        // The shape the guard exists for still reads.
        expect(
            execFileSync(
                'sh',
                [
                    '-c',
                    readWithinRootCommand(path.join(dir, 'a.ts'), dir, 2, 3),
                ],
                { encoding: 'utf8' },
            ),
        ).toBe('two\nthree\n');
    });

    it('refuses the same values at the local provider itself', async () => {
        const written = path.join(outside, 'written');
        const rc = (
            new LocalSandboxService({} as any) as any
        ).buildRemoteCommands(dir);

        await expect(rc.read('a.ts', 1, `1p;w ${written}`)).rejects.toThrow(
            /line/i,
        );
        expect(fs.existsSync(written)).toBe(false);
    });

    describe('local provider read', () => {
        const rc = () =>
            (new LocalSandboxService({} as any) as any).buildRemoteCommands(
                dir,
            );

        it('reads the whole file, a range, or from the first line', async () => {
            expect(await rc().read('a.ts', 0, 0)).toBe('one\ntwo\nthree\n');
            expect(await rc().read('a.ts', 0, 2)).toBe('one\ntwo\n');
            expect(await rc().read('a.ts', 2, 3)).toBe('two\nthree\n');
        });

        it('reads under a linked repository cloned in the checkout', async () => {
            const linked = path.join(dir, '_linked', 'lib');
            fs.mkdirSync(linked, { recursive: true });
            fs.writeFileSync(path.join(linked, 'b.ts'), 'linked\n');

            expect(await rc().read('b.ts', 0, 0, linked)).toBe('linked\n');
        });

        it('refuses a root outside the checkout, directly or through a symlink', async () => {
            fs.mkdirSync(path.join(dir, '_linked'), { recursive: true });
            fs.symlinkSync(outside, path.join(dir, '_linked', 'escape'));

            for (const root of [outside, path.join(dir, '_linked', 'escape')]) {
                await expect(
                    rc().read('secret.env', 0, 0, root),
                ).rejects.toThrow('Not a repository root of this sandbox');
            }
        });
    });
});
