import { spawnSync } from 'child_process';
import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    buildCliPrefixInstallScript,
    cliLayerPrefix,
    cliPrefixEnv,
    cliPrefixHome,
    parseCliPrefixInstall,
    parseToolLayerHit,
} from './cli-prefix-install';

// Runs the REAL install script under sh against a temp prefix. The package
// manager step is a shell snippet that lays down files the way npm/pip do.
function runInstall(setup: string, binary = 'tool') {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kcli-')));
    const script = buildCliPrefixInstallScript({
        id: 'abc',
        argv: ['sh', '-c', setup],
        binary,
    })
        .split('/workspace/.kcli')
        .join(root)
        .replace(/\/usr\/bin\/timeout -k 5 \d+ /, '');
    const r = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    return { root, ...r };
}

describe('buildCliPrefixInstallScript', () => {
    it('finds a symlinked script on a noexec mount (no exec bit) and records node as its interpreter', () => {
        const r = runInstall(
            `mkdir -p node_modules/pkg node_modules/.bin && printf '#!/usr/bin/env node\\n' > node_modules/pkg/cli.js && ln -s ../pkg/cli.js node_modules/.bin/tool`,
        );
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(
            `KODUS_CLI_BINARY=${r.root}/abc/node_modules/pkg/cli.js`,
        );
        expect(r.stdout).toContain('KODUS_CLI_INTERPRETER=node');
    });

    it.each([
        ['#!/usr/bin/python3', 'python3'],
        ['#!/tmp/x/bin/python', 'python3'],
        ['#!/bin/bash', 'bash'],
        ['#!/bin/sh', 'sh'],
    ])('maps shebang %s to %s', (shebang, interpreter) => {
        const r = runInstall(
            `mkdir -p .local/bin && printf '${shebang}\\n' > .local/bin/tool`,
        );
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`KODUS_CLI_INTERPRETER=${interpreter}`);
    });

    it('refuses a native ELF binary with a clear warning', () => {
        const r = runInstall(
            `mkdir -p .local/bin && printf '\\177ELF\\002\\001\\001' > .local/bin/tool`,
        );
        expect(r.status).toBe(4);
        expect(r.stderr).toContain('native executable');
        expect(r.stdout).not.toContain('KODUS_CLI_BINARY');
    });

    it('reports a missing binary', () => {
        const r = runInstall('true');
        expect(r.status).toBe(3);
        expect(r.stderr).toContain('not found after install');
    });
});

describe('parseCliPrefixInstall', () => {
    const home = cliPrefixHome('abc');
    it('accepts a path inside the prefix with a known interpreter', () => {
        expect(
            parseCliPrefixInstall(
                'abc',
                `noise\nKODUS_CLI_BINARY=${home}/node_modules/x/cli.js\nKODUS_CLI_INTERPRETER=node\n`,
            ),
        ).toEqual({
            binaryPath: `${home}/node_modules/x/cli.js`,
            interpreter: 'node',
        });
    });
    it('rejects paths outside the prefix, traversal and unknown interpreters', () => {
        expect(
            parseCliPrefixInstall(
                'abc',
                'KODUS_CLI_BINARY=/usr/bin/evil\nKODUS_CLI_INTERPRETER=node',
            ),
        ).toBeUndefined();
        expect(
            parseCliPrefixInstall(
                'abc',
                `KODUS_CLI_BINARY=${home}/../x\nKODUS_CLI_INTERPRETER=node`,
            ),
        ).toBeUndefined();
        expect(
            parseCliPrefixInstall(
                'abc',
                `KODUS_CLI_BINARY=${home}/a\nKODUS_CLI_INTERPRETER=perl`,
            ),
        ).toBeUndefined();
    });
});

describe('cliPrefixEnv', () => {
    it('points the install into the prefix and HOME and the cache into the home', () => {
        const env = cliPrefixEnv({ prefix: '/opt/kcli/abc', home: '/workspace/.kcli/abc' });
        expect(env).toEqual(
            expect.arrayContaining([
                'HOME=/workspace/.kcli/abc',
                'PATH=/opt/kcli/abc/.local/bin:/opt/kcli/abc/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
                'NPM_CONFIG_PREFIX=/opt/kcli/abc/.local',
                'NPM_CONFIG_CACHE=/workspace/.kcli/abc/.cache/npm',
                'PNPM_HOME=/opt/kcli/abc/.local/bin',
                'PYTHONUSERBASE=/opt/kcli/abc/.local',
            ]),
        );
        // Nothing writable-by-design points into the read-only prefix.
        expect(env.filter((e) => e.startsWith('HOME=') || e.includes('CACHE'))).toEqual(['HOME=/workspace/.kcli/abc', 'NPM_CONFIG_CACHE=/workspace/.kcli/abc/.cache/npm']);
    });

    it('is what an install into the workspace always had when prefix and home are one directory', () => {
        const home = cliPrefixHome('abc');
        expect(cliPrefixEnv({ prefix: home, home })).toEqual([
            `HOME=${home}`,
            `PATH=${home}/.local/bin:${home}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
            `NPM_CONFIG_PREFIX=${home}/.local`,
            `NPM_CONFIG_CACHE=${home}/.cache/npm`,
            `PNPM_HOME=${home}/.local/bin`,
            'PIP_USER=1',
            'PIP_BREAK_SYSTEM_PACKAGES=1',
            `PYTHONUSERBASE=${home}/.local`,
            `PIPX_HOME=${home}/.local/pipx`,
            `PIPX_BIN_DIR=${home}/.local/bin`,
            `UV_TOOL_DIR=${home}/.local/uv`,
            `UV_TOOL_BIN_DIR=${home}/.local/bin`,
        ]);
    });
});

describe('parseToolLayerHit', () => {
    const prefix = cliLayerPrefix('abc');
    it('accepts a path under the own mount of the layer with a known interpreter', () => {
        expect(parseToolLayerHit('abc', { binaryPath: `${prefix}/node_modules/x/cli.js`, interpreter: 'node' })).toEqual({
            binaryPath: `${prefix}/node_modules/x/cli.js`,
            interpreter: 'node',
        });
    });
    it('rejects another layer mount, the workspace prefix, traversal, an unknown interpreter and a missing field', () => {
        for (const hit of [
            { binaryPath: '/opt/kcli/other/x', interpreter: 'node' },
            { binaryPath: `${cliPrefixHome('abc')}/x`, interpreter: 'node' },
            { binaryPath: `${prefix}/../x`, interpreter: 'node' },
            { binaryPath: `${prefix}/x`, interpreter: 'perl' },
            { binaryPath: `${prefix}/x` },
            { interpreter: 'node' },
        ]) {
            expect(parseToolLayerHit('abc', hit)).toBeUndefined();
        }
    });
});
