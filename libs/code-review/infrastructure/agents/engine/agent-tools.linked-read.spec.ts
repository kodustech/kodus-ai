import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildE2BRemoteCommands } from '@libs/sandbox/infrastructure/providers/e2b-sandbox.service';
import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';

import { buildAgentTools } from './agent-tools.factory';

/**
 * readFile on a linked repository goes through the provider's own read,
 * rooted at the clone, so a symlink the linked repository commits is refused
 * the same way as one in the PR's repository.
 */
describe('agent tools — readFile on a linked repository', () => {
    let base: string;
    let repoDir: string;
    let linkedRoot: string;

    const linkedRepoAccess = (rootPath: string): any => ({
        list: () => [{ repository: 'acme/shared', preferredRef: 'main' }],
        ensureCloned: async () => ({
            ok: true,
            rootPath,
            repository: 'acme/shared',
        }),
    });

    beforeEach(() => {
        base = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-linked-read-')),
        );
        repoDir = path.join(base, 'repo');
        // Local layout from resolve-linked-repositories: `<repoDir>/_linked/<slug>`.
        linkedRoot = path.join(repoDir, '_linked', 'acme-shared');
        fs.mkdirSync(path.join(linkedRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(linkedRoot, 'src', 'a.ts'), 'one\ntwo\n');
        fs.writeFileSync(path.join(base, 'secret.env'), 'TOKEN=hunter2\n');
        fs.symlinkSync(
            path.join(base, 'secret.env'),
            path.join(linkedRoot, 'notes.txt'),
        );
    });

    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    const localTools = (root = linkedRoot) =>
        buildAgentTools(
            (new LocalSandboxService({} as any) as any).buildRemoteCommands(
                repoDir,
            ),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            linkedRepoAccess(root),
        );

    it('reads a file of the linked clone in the local sandbox', async () => {
        const out = await localTools().readFile.execute({
            path: 'src/a.ts',
            repo: 'acme/shared',
            startLine: 2,
            endLine: 2,
        });

        expect(out).toContain('[linked repo: acme/shared');
        expect(out).toContain('2: two');
    });

    it('refuses a symlink the linked repository commits', async () => {
        const out = await localTools().readFile.execute({
            path: 'notes.txt',
            repo: 'acme/shared',
        });

        expect(out).toMatch(/Symlink detected/);
        expect(out).not.toContain('hunter2');
    });

    it('refuses a root outside the checkout', async () => {
        const out = await localTools(base).readFile.execute({
            path: 'secret.env',
            repo: 'acme/shared',
        });

        expect(out).toMatch(/Not a repository root/);
        expect(out).not.toContain('hunter2');
    });

    it('reads under the E2B linked root with the guarded command', async () => {
        const run = jest
            .fn()
            .mockResolvedValue({ stdout: 'body\n', stderr: '', exitCode: 0 });
        const rc = buildE2BRemoteCommands({ commands: { run } } as any);

        await expect(
            rc.read('src/a.ts', 0, 0, '/home/user/_linked/acme-shared'),
        ).resolves.toBe('body\n');
        const cmd = run.mock.calls[0][0] as string;
        expect(cmd).toContain("f='/home/user/_linked/acme-shared/src/a.ts'");
        expect(cmd).toContain('Symlink detected, refusing to follow');
        // The root itself must be its own real path: a symlinked root is
        // refused in the sandbox's shell (read-within-root.spec runs it).
        expect(cmd).toContain(
            `if [ "$r" != '/home/user/_linked/acme-shared' ]; then echo "Not a real directory`,
        );

        await expect(rc.read('passwd', 0, 0, '/etc')).rejects.toThrow(
            /Not a repository root/,
        );
        await expect(
            rc.read('x', 0, 0, '/home/user/_linked/../.ssh'),
        ).rejects.toThrow(/Not a repository root/);
    });

    it('takes only the checkout or a clone under _linked as an E2B root', async () => {
        const run = jest
            .fn()
            .mockResolvedValue({ stdout: 'body\n', stderr: '', exitCode: 0 });
        const rc = buildE2BRemoteCommands({ commands: { run } } as any);

        await expect(rc.read('a.ts', 0, 0, '/home/user/repo')).resolves.toBe(
            'body\n',
        );
        expect(run.mock.calls[0][0]).toContain("f='/home/user/repo/a.ts'");

        for (const root of [
            '/home/user/another-checkout',
            '/home/user/_linked/',
            '/home/user/_linked',
            '/home/user/_linkedX/acme',
            '/tmp/home/user/_linked/acme',
        ]) {
            await expect(rc.read('a.ts', 0, 0, root)).rejects.toThrow(
                /Not a repository root/,
            );
        }
        expect(run).toHaveBeenCalledTimes(1);
    });
});
