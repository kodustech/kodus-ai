import { buildAgentTools } from './agent-tools.factory';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

/**
 * Regression tests for sandbox tool error-handling.
 *
 * The e2b/local sandboxes surface command failures through the OUTPUT channel:
 * `exec` merges stderr into stdout and returns a truthful exitCode, while
 * read/listDir return a bare string. Two tools used to trust that output and
 * hand the model garbage:
 *   1. findFile returned "fd: command not found" as if it were a file list
 *      (it ignored exitCode), so the find/listDir fallbacks never ran.
 *   2. readFile returned blank numbered lines ("500: ") when a read produced
 *      no content (range past EOF, or empty file), giving no signal.
 */
function makeRemote(overrides: Partial<RemoteCommands> = {}): RemoteCommands {
    return {
        grep: async () => '',
        read: async () => '',
        listDir: async () => '',
        ...overrides,
    };
}

describe('findFile — resilient to a missing fd binary', () => {
    it('falls through to find when fd is not installed (never returns the fd error)', async () => {
        const remote = makeRemote({
            exec: async (cmd: string) => {
                if (cmd.startsWith('fd ')) {
                    // Post-unmerge: the shell error lands on stderr, exit 127.
                    return {
                        stdout: '',
                        stderr: '/bin/bash: line 1: fd: command not found',
                        exitCode: 127,
                    };
                }
                if (cmd.startsWith('find ')) {
                    return {
                        stdout: 'src/foo.ts\nsrc/foo.test.ts',
                        stderr: '',
                        exitCode: 0,
                    };
                }
                return { stdout: '', stderr: '', exitCode: 0 };
            },
        });
        const out = await buildAgentTools(remote).findFile.execute({
            pattern: 'foo',
        });
        expect(out).not.toMatch(/command not found/);
        expect(out).toContain('src/foo.ts');
    });

    it('falls through to listDir when both fd and find are unavailable', async () => {
        const remote = makeRemote({
            exec: async (cmd: string) => ({
                stdout: '',
                stderr: `${cmd.split(' ')[0]}: command not found`,
                exitCode: 127,
            }),
            listDir: async () => 'src/foo.ts\nsrc/bar.ts',
        });
        const out = await buildAgentTools(remote).findFile.execute({
            pattern: 'foo',
        });
        expect(out).not.toMatch(/command not found/);
        expect(out).toContain('src/foo.ts');
        expect(out).not.toContain('bar.ts');
    });

    it('still returns fd results when fd works (happy path preserved)', async () => {
        const remote = makeRemote({
            exec: async (cmd: string) =>
                cmd.startsWith('fd ')
                    ? { stdout: 'src/config.ts', stderr: '', exitCode: 0 }
                    : { stdout: '', stderr: '', exitCode: 0 },
        });
        const out = await buildAgentTools(remote).findFile.execute({
            pattern: 'config',
        });
        expect(out).toBe('src/config.ts');
    });
});

describe('readFile — clear signal when a read produces no content', () => {
    it('surfaces a near-miss suggestion when the path does not exist (read throws)', async () => {
        const remote = makeRemote({
            read: async () => {
                throw new Error(
                    'cat: src/localStore: No such file or directory',
                );
            },
            listDir: async () => 'src/localStore.ts\nsrc/other.ts',
        });
        const out = await buildAgentTools(remote).readFile.execute({
            path: 'src/localStore',
        });
        expect(out).toMatch(/Did you mean/);
    });

    it('signals an out-of-range read instead of returning a blank numbered line', async () => {
        const remote = makeRemote({ read: async () => '' });
        const out = await buildAgentTools(remote).readFile.execute({
            path: 'src/foo.ts',
            startLine: 500,
            endLine: 550,
        });
        expect(out).not.toMatch(/^500:\s*$/);
        expect(out.toLowerCase()).toMatch(/no content|fewer than|beyond|range/);
    });

    it('reports an empty file clearly (whole-file read returns nothing)', async () => {
        const remote = makeRemote({ read: async () => '' });
        const out = await buildAgentTools(remote).readFile.execute({
            path: 'src/empty.ts',
        });
        expect(out.toLowerCase()).toMatch(/empty/);
    });
});
