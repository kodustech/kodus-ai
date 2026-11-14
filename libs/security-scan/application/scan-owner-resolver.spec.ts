import { ScanOwnerResolver } from './scan-owner-resolver';

function sandboxWith(
    files: Record<string, string>,
    log = 'Ana Lima\tana@acme.io',
) {
    const run = jest.fn(async (command: string) => {
        if (command.includes(' fetch ')) {
            return { stdout: '', exitCode: 0 };
        }
        if (command.includes(' log -1 ')) {
            return { stdout: `${log}\n`, exitCode: 0 };
        }
        return { stdout: '', exitCode: 1 };
    });
    return {
        repoDir: '/home/user/repo',
        type: 'e2b',
        run,
        remoteCommands: {
            read: jest.fn(async (path: string) => {
                if (files[path] === undefined) {
                    throw new Error('No such file');
                }
                return files[path];
            }),
        },
    } as any;
}

describe('ScanOwnerResolver', () => {
    it('names the CODEOWNERS owner of the file', async () => {
        const sandbox = sandboxWith({
            '.github/CODEOWNERS':
                '* @acme/platform\n/src/billing/ @acme/billing',
        });
        const resolver = new ScanOwnerResolver(sandbox);

        await expect(
            resolver.ownerOf('src/billing/charge.ts'),
        ).resolves.toEqual({
            gitId: '',
            username: '@acme/billing',
            origin: 'codeowners',
        });
        expect(sandbox.run).not.toHaveBeenCalled();
    });

    it('keeps an email owner as the email', async () => {
        const sandbox = sandboxWith({ CODEOWNERS: '*.go dev@acme.io' });
        const resolver = new ScanOwnerResolver(sandbox);

        await expect(resolver.ownerOf('cmd/main.go')).resolves.toEqual({
            gitId: '',
            username: 'dev',
            email: 'dev@acme.io',
            origin: 'codeowners',
        });
    });

    it('falls back to the last author, fetching history once with the auth header in env', async () => {
        const sandbox = sandboxWith({});
        const resolver = new ScanOwnerResolver(sandbox, {
            cloneUrl: 'https://github.com/acme/shop.git',
            branch: 'main',
            authHeader: 'Authorization: Basic abc',
        });
        await resolver.prepareHistory();

        await expect(resolver.ownerOf('src/a.ts')).resolves.toEqual({
            gitId: '',
            username: 'Ana Lima',
            email: 'ana@acme.io',
            origin: 'last_author',
        });
        await resolver.ownerOf('src/b.ts');

        const fetches = sandbox.run.mock.calls.filter(([c]: [string]) =>
            c.includes(' fetch '),
        );
        expect(fetches).toHaveLength(1);
        expect(fetches[0][0]).not.toContain('Basic abc');
        expect(fetches[0][0]).not.toContain('$GIT_AUTH_HEADER');
        expect(fetches[0][0]).toContain('--no-recurse-submodules');
        expect(fetches[0][1].envs).toEqual({
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader',
            GIT_CONFIG_VALUE_0: 'Authorization: Basic abc',
        });
        // No hook or fsmonitor the repository set can run beside the token.
        expect(fetches[0][0]).toContain('-c core.hooksPath=/dev/null');
        expect(fetches[0][0]).toContain('-c core.fsmonitor= ');
    });

    it('never fetches with the token once repository code may have run', async () => {
        const sandbox = sandboxWith({});
        const resolver = new ScanOwnerResolver(sandbox, {
            cloneUrl: 'https://github.com/acme/shop.git',
            branch: 'main',
            authHeader: 'Authorization: Basic abc',
        });

        // History was not prepared right after the clone: no last author,
        // and no credentialed fetch later on.
        await expect(resolver.ownerOf('src/a.ts')).resolves.toBeUndefined();
        expect(sandbox.run).not.toHaveBeenCalled();
    });

    it('leaves the finding without an owner when history is out of reach', async () => {
        const sandbox = sandboxWith({});
        const resolver = new ScanOwnerResolver(sandbox);

        await expect(resolver.ownerOf('src/a.ts')).resolves.toBeUndefined();
    });
});
