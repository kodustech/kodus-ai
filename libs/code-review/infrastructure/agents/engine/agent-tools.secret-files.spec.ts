import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';

import { buildAgentTools } from './agent-tools.factory';

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

    it.each(['.env', 'certs/server.pem', 'CERTS/Server.PEM', '/.env'])(
        'does not read %s',
        async (file) => {
            const out = await buildAgentTools(rc).readFile.execute({
                path: file,
            });

            expect(out).not.toContain(VALUE);
            expect(out).toContain('secret');
        },
    );

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
