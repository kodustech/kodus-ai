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
            await tools.readFile.execute({ path: 'a.ts', startLine: 2, endLine: 2 }),
        ).toContain('2: two');
        expect(
            await tools.readFile.execute({
                path: 'a.ts',
                startLine: '2',
                endLine: '3',
            }),
        ).toContain('3: three');
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
            readWithinRootCommand(path.join(dir, 'a.ts'), dir, 1, injected as any),
        ).toThrow(/line/i);

        // The shape the guard exists for still reads.
        expect(
            execFileSync(
                'sh',
                ['-c', readWithinRootCommand(path.join(dir, 'a.ts'), dir, 2, 3)],
                { encoding: 'utf8' },
            ),
        ).toBe('two\nthree\n');
    });

    it('refuses the same values at the local provider itself', async () => {
        const written = path.join(outside, 'written');
        const rc = (new LocalSandboxService({} as any) as any).buildRemoteCommands(
            dir,
        );

        await expect(rc.read('a.ts', 1, `1p;w ${written}`)).rejects.toThrow(
            /line/i,
        );
        expect(fs.existsSync(written)).toBe(false);
    });
});
