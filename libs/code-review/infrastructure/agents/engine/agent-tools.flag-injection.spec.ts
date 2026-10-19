import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';

import { buildAgentTools } from './agent-tools.factory';

/**
 * The model chooses the grep pattern and path and the findFile path. A value
 * starting with "-" must never reach rg, fd or find as an option: rg's
 * `--pre` runs a command over every file searched, and find's `-delete`
 * removes them. `--files` stands in for `--pre` here: it is an rg option
 * that changes the output without running anything.
 */
describe('agent tools — model input is never an option', () => {
    let dir: string;
    let rc: any;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-flag-injection-'));
        fs.writeFileSync(path.join(dir, 'plain.txt'), 'nothing here\n');
        fs.writeFileSync(path.join(dir, 'flag.txt'), 'uses --files here\n');
        rc = (new LocalSandboxService({} as any) as any).buildRemoteCommands(
            dir,
        );
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // The local sandbox refuses rg through exec, so this runs the provider's
    // own grep with a real rg.
    it('searches the local checkout for a pattern that looks like an rg option', async () => {
        const out = await buildAgentTools(rc).grep.execute({
            pattern: '--files',
        });

        expect(out).toContain('flag.txt');
        expect(out).toContain('uses --files here');
        expect(out).not.toContain('plain.txt');
    });

    it('passes the pattern with -e and the path after --', async () => {
        const commands: string[] = [];
        const remote = {
            grep: async () => '',
            read: async () => '',
            listDir: async () => '',
            exec: async (cmd: string) => {
                commands.push(cmd);
                return { stdout: '', stderr: '', exitCode: 1 };
            },
        };

        await buildAgentTools(remote).grep.execute({
            pattern: '--pre=sh',
            path: '-src',
        });

        expect(commands[0]).toContain(`-e '--pre=sh' -- '-src'`);
    });

    it('refuses a grep path that climbs out of the checkout', async () => {
        const exec = jest.fn();
        const out = await buildAgentTools({
            grep: jest.fn(),
            read: async () => '',
            listDir: async () => '',
            exec,
        }).grep.execute({ pattern: 'TOKEN', path: '../../../proc' });

        expect(out).toBe('Error: Path traversal using ".." is not allowed');
        expect(exec).not.toHaveBeenCalled();
    });

    it('anchors a findFile path starting with "-" to the checkout', async () => {
        const commands: string[] = [];
        await buildAgentTools({
            grep: async () => '',
            read: async () => '',
            listDir: async () => '',
            exec: async (cmd: string) => {
                commands.push(cmd);
                return { stdout: '', stderr: '', exitCode: 1 };
            },
        }).findFile.execute({ pattern: '-x*', path: '-delete' });

        const fd = commands.find((cmd) => cmd.startsWith('fd '));
        const find = commands.find((cmd) => cmd.startsWith('find '));
        expect(fd).toContain(`-- '-x*' './-delete'`);
        expect(find).toContain(`find './-delete' `);
    });
});
