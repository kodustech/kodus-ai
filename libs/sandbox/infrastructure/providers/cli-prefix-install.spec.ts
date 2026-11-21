import { spawnSync } from 'child_process';
import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    buildCliPrefixInstallScript,
    cliPrefixHome,
    parseCliPrefixInstall,
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
