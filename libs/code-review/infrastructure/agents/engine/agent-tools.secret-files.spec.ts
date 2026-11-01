import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';

import { buildFinderToolRegistry } from '../adapters/finder-tools.adapter';
import { buildAgentTools, MAX_GREP_GROUPS } from './agent-tools.factory';
import { withoutSecretFileLines } from './secret-files';

/**
 * A repository can commit credentials: an env file, a private key. What a
 * tool returns goes to the model provider and into the review's trace, so
 * the agent tools never return a secret file's content. Templates of env
 * files hold variable names, not values, and stay readable.
 */
describe('agent tools — secret files of the repository', () => {
    const VALUE = 'FAKE_VALUE_7f3a';
    let dir: string;
    let rc: any;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-secret-files-'));
        fs.mkdirSync(path.join(dir, 'certs'));
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, '.env'), `API_TOKEN=${VALUE}\n`);
        fs.writeFileSync(
            path.join(dir, 'certs', 'server.pem'),
            `-----BEGIN PRIVATE KEY-----\n${VALUE}\n`,
        );
        fs.writeFileSync(path.join(dir, '.env.example'), 'API_TOKEN=\n');
        // Long enough, with declarations, for the outline-first read.
        fs.writeFileSync(
            path.join(dir, '.env.local'),
            Array.from(
                { length: 200 },
                (_, i) => `export const KEY_${i} = '${VALUE}';`,
            ).join('\n'),
        );
        fs.writeFileSync(
            path.join(dir, 'src', 'config.ts'),
            `export const name = '${VALUE}';\n`,
        );
        rc = (new LocalSandboxService({} as any) as any).buildRemoteCommands(
            dir,
        );
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it.each([
        '.env',
        'certs/server.pem',
        'CERTS/Server.PEM',
        '/.env',
        'certs/./server.pem',
        'src/../.env',
    ])('does not read %s', async (file) => {
        const out = await buildAgentTools(rc).readFile.execute({
            path: file,
        });

        expect(out).not.toContain(VALUE);
        expect(out).toContain('secret');
    });

    it('reads an env template', async () => {
        const out = await buildAgentTools(rc).readFile.execute({
            path: '.env.example',
        });

        expect(out).toContain('API_TOKEN=');
    });

    it('greps the code and leaves the secret files out', async () => {
        const out = await buildAgentTools(rc).grep.execute({
            pattern: VALUE,
        });

        expect(out).toContain('src/config.ts');
        expect(out).not.toContain('server.pem');
        expect(out).not.toContain('PRIVATE KEY');
    });

    it('does not grep a secret file named as the path', async () => {
        const out = await buildAgentTools(rc).grep.execute({
            pattern: 'API_TOKEN',
            path: '.env',
        });

        expect(out).not.toContain(VALUE);
    });

    it('does not grep a secret file under another spelling of its path', async () => {
        const out = await buildAgentTools(rc).grep.execute({
            pattern: VALUE,
            path: 'certs/./server.pem',
        });

        expect(out).not.toContain(VALUE);
    });

    it.each(['directory', 'dir'])(
        'does not grep a secret file named as %s',
        async (alias) => {
            const out = await buildAgentTools(rc).grep.execute({
                pattern: 'API_TOKEN',
                [alias]: '.env',
            });

            expect(out).not.toContain(VALUE);
        },
    );

    it('does not outline a secret file on an outline-first read', async () => {
        const { registry } = buildFinderToolRegistry({
            remoteCommands: rc,
            outlineFirst: true,
        });

        const res = await registry
            .get('readFile')!
            .execute({ path: '.env.local' }, {} as any);

        expect(res.output).not.toContain(VALUE);
        expect(res.output).not.toContain('KEY_1');
        expect(res.output).toContain('secret');
    });

    it('does not read a linked repository file through a symlink', async () => {
        const root = path.join(dir, 'linked');
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, '.env'), `API_TOKEN=${VALUE}\n`);
        fs.writeFileSync(path.join(root, 'ok.txt'), 'plain\n');
        fs.symlinkSync('.env', path.join(root, 'notes.txt'));
        // Linked repositories are cloned in a remote sandbox, whose exec is
        // a shell: here, a real one.
        const shell = {
            grep: async () => '',
            read: async () => '',
            listDir: async () => '',
            exec: async (cmd: string) => {
                try {
                    return {
                        stdout: execFileSync('sh', ['-c', cmd], {
                            encoding: 'utf8',
                        }),
                        stderr: '',
                        exitCode: 0,
                    };
                } catch (err: any) {
                    return {
                        stdout: String(err.stdout ?? ''),
                        stderr: String(err.stderr ?? ''),
                        exitCode: err.status ?? 1,
                    };
                }
            },
        };
        const linkedRepoAccess: any = {
            list: () => [
                {
                    repository: 'org/api',
                    preferredRef: 'main',
                    status: 'ready',
                },
            ],
            ensureCloned: async () => ({
                ok: true,
                rootPath: root,
                repository: 'org/api',
            }),
        };
        const tools = buildAgentTools(
            shell,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            linkedRepoAccess,
        );

        const viaLink = await tools.readFile.execute({
            path: 'notes.txt',
            repo: 'org/api',
        });
        const plain = await tools.readFile.execute({
            path: 'ok.txt',
            repo: 'org/api',
        });

        expect(viaLink).not.toContain(VALUE);
        expect(viaLink).toContain('symlink');
        expect(plain).toContain('plain');
    });

    it("drops a linked repository's secret files from its tagged grep lines", () => {
        const out = withoutSecretFileLines(
            [
                `[org/api] src/config.ts:1:export const name = '${VALUE}';`,
                `[org/api] id_rsa:2:${VALUE}`,
                `[org/api] .env-3-API_TOKEN=${VALUE}`,
                '[org/api] certs/server.pem',
            ].join('\n'),
        );

        expect(out).toBe(
            `[org/api] src/config.ts:1:export const name = '${VALUE}';`,
        );
    });

    it('keeps a match whose text names a secret file', () => {
        const lines = [
            'docs/setup.md:3:Put the certificate in server.pem',
            'docs/setup.md-4-and the private key in tls.key',
        ].join('\n');

        expect(withoutSecretFileLines(lines)).toBe(lines);
    });

    it('does not let secret file matches use up the grep result limit', async () => {
        const repo = fs.mkdtempSync(
            path.join(os.tmpdir(), 'kodus-secret-limit-'),
        );
        try {
            // One rg match group per secret line, past MAX_GREP_GROUPS.
            fs.writeFileSync(
                path.join(repo, 'big.pem'),
                Array.from(
                    { length: MAX_GREP_GROUPS + 10 },
                    (_, i) => `KEY_${i}=${VALUE}\n\n\n\n\n\n`,
                ).join(''),
            );
            fs.mkdirSync(path.join(repo, 'src'));
            fs.writeFileSync(
                path.join(repo, 'src', 'app.ts'),
                `export const v = '${VALUE}';\n`,
            );
            const repoRc = (
                new LocalSandboxService({} as any) as any
            ).buildRemoteCommands(repo);

            const out = await buildAgentTools(repoRc).grep.execute({
                pattern: VALUE,
            });

            expect(out).toContain('src/app.ts');
            expect(out).not.toContain('more matches hidden');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('does not let secret file matches use up the sandbox rg limit', async () => {
        const secretGroups = Array.from(
            { length: MAX_GREP_GROUPS + 10 },
            (_, i) => `certs/server.pem:${i * 10 + 1}:${VALUE}`,
        );
        const remote = {
            grep: async () => '',
            read: async () => '',
            listDir: async () => '',
            exec: async () => ({
                stdout: [
                    ...secretGroups,
                    `src/config.ts:1:export const name = '${VALUE}';`,
                ].join('\n--\n'),
                stderr: '',
                exitCode: 0,
            }),
        };

        const out = await buildAgentTools(remote).grep.execute({
            pattern: VALUE,
        });

        expect(out).toBe(`src/config.ts:1:export const name = '${VALUE}';`);
    });

    it('drops secret files from the sandbox rg output, context lines included', async () => {
        const remote = {
            grep: async () => '',
            read: async () => '',
            listDir: async () => '',
            exec: async () => ({
                stdout: [
                    `src/config.ts:1:export const name = '${VALUE}';`,
                    '--',
                    `certs/server.pem-1------BEGIN PRIVATE KEY-----`,
                    `certs/server.pem:2:${VALUE}`,
                ].join('\n'),
                stderr: '',
                exitCode: 0,
            }),
        };

        const out = await buildAgentTools(remote).grep.execute({
            pattern: VALUE,
        });

        expect(out).toContain('src/config.ts:1:');
        expect(out).not.toContain('server.pem');
    });
});
