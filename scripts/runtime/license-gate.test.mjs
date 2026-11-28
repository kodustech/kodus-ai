import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
    parseSpdx,
    productionClosure,
    satisfies,
    validateExceptions,
    violations,
} from './license-gate.mjs';

const gate = fileURLToPath(new URL('./license-gate.mjs', import.meta.url));
const NONE = { licenses: {}, packages: [] };

/** An installed project: { name: { license, dependencies, dir } } written below node_modules. */
async function project(t, rootPkg, packages) {
    const root = await mkdtemp(join(tmpdir(), 'license-gate-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'package.json'), JSON.stringify(rootPkg));
    await mkdir(join(root, 'node_modules'));
    for (const [name, pkg] of Object.entries(packages)) {
        const dir = join(root, pkg.dir ?? join('node_modules', name));
        await mkdir(dir, { recursive: true });
        const { dir: _dir, ...json } = pkg;
        await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...json }));
    }
    return root;
}

const failing = (root, image, exceptions = NONE) =>
    violations(productionClosure(root).packages, image, exceptions).map((p) => `${p.name}:${p.license}`);

test('a dev-only package never counts against an image', async (t) => {
    const root = await project(
        t,
        { dependencies: { ok: '1' }, devDependencies: { preview: '1' } },
        {
            ok: { license: 'MIT' },
            preview: { license: 'MIT', dependencies: { libvips: '1' } },
            libvips: { license: 'LGPL-3.0-or-later' },
        },
    );
    assert.deepEqual(failing(root, 'backend'), []);
});

test('a copyleft, weak-copyleft or source-available package in the production closure fails', async (t) => {
    const root = await project(
        t,
        { dependencies: { a: '1' } },
        {
            a: { license: 'MIT', dependencies: { b: '1', c: '1', d: '1', e: '1' } },
            b: { license: 'MPL-2.0' },
            c: { license: 'BUSL-1.1' },
            d: { license: 'SSPL-1.0' },
            e: { license: 'Elastic-2.0' },
        },
    );
    assert.deepEqual(failing(root, 'backend'), ['b:MPL-2.0', 'c:BUSL-1.1', 'd:SSPL-1.0', 'e:Elastic-2.0']);
});

test('a package with no licence, or one that does not parse, fails', async (t) => {
    const root = await project(
        t,
        { dependencies: { a: '1', b: '1' } },
        { a: {}, b: { license: 'MIT OR' } },
    );
    assert.deepEqual(failing(root, 'backend'), ['a:UNKNOWN', 'b:MIT OR']);
});

test('an expression passes only when an allowed choice exists', () => {
    const ok = (expression) => satisfies(parseSpdx(expression), (id) => ['MIT', 'Apache-2.0'].includes(id));
    assert.equal(ok('(MIT OR GPL-3.0-only)'), true);
    assert.equal(ok('MIT AND GPL-3.0-only'), false);
    assert.equal(ok('Apache-2.0 WITH LLVM-exception'), true);
    assert.equal(parseSpdx('(MIT'), null);
});

test('SPDX ids match case-insensitively, and the legacy licenses array is read', async (t) => {
    const root = await project(
        t,
        { dependencies: { a: '1', b: '1' } },
        { a: { license: 'apache-2.0' }, b: { licenses: [{ type: 'MIT' }] } },
    );
    assert.deepEqual(failing(root, 'backend'), []);
});

test('a reviewed package exception covers only its image and its exact licence', async (t) => {
    const root = await project(
        t,
        { dependencies: { next: '1' } },
        {
            next: { license: 'MIT', optionalDependencies: { '@img/sharp-libvips-linux-x64': '1', '@img/sharp-libvips-linux-arm64': '1' } },
            '@img/sharp-libvips-linux-x64': { license: 'LGPL-3.0-or-later' },
        },
    );
    const exceptions = {
        licenses: {},
        packages: [
            {
                package: '@img/sharp-libvips-*',
                license: 'LGPL-3.0-or-later',
                images: ['web'],
                reason: 'dynamically linked shared library, replaceable by the user',
            },
        ],
    };
    assert.deepEqual(failing(root, 'web', exceptions), []);
    assert.deepEqual(failing(root, 'backend', exceptions), ['@img/sharp-libvips-linux-x64:LGPL-3.0-or-later']);
    const relicensed = structuredClone(exceptions);
    relicensed.packages[0].license = 'LGPL-2.1-only';
    assert.deepEqual(failing(root, 'web', relicensed), ['@img/sharp-libvips-linux-x64:LGPL-3.0-or-later']);
});

test('MPL, LGPL and source-available licences cannot be reviewed for every image', () => {
    for (const id of ['MPL-2.0', 'LGPL-3.0-or-later', 'GPL-2.0-only', 'BUSL-1.1', 'SSPL-1.0', 'Elastic-2.0', 'FSL-1.1-MIT'])
        assert.notDeepEqual(validateExceptions({ licenses: { [id]: 'reviewed for every image, really' } }), [], id);
    assert.deepEqual(validateExceptions({ licenses: { 'BlueOak-1.0.0': 'permissive, OSI approved, no copyleft' } }), []);
    assert.notDeepEqual(validateExceptions({ packages: [{ package: 'x', license: 'MPL-2.0', images: ['web'] }] }), []);
});

test('a nested copy resolves before the hoisted one, as Node resolves it', async (t) => {
    const root = await project(
        t,
        { dependencies: { a: '1' } },
        {
            a: { license: 'MIT', dependencies: { b: '1' } },
            b: { license: 'MIT' },
            'a-b': { dir: 'node_modules/a/node_modules/b', license: 'GPL-3.0-only' },
        },
    );
    // The nested package.json is named after its folder in this fixture.
    const closure = productionClosure(root).packages.map((p) => p.dir).sort();
    assert.deepEqual(closure, ['node_modules/a', 'node_modules/a/node_modules/b']);
});

test('a required dependency that is not installed is a setup error, never a pass', async (t) => {
    const root = await project(t, { dependencies: { a: '1' } }, { a: { license: 'MIT', dependencies: { gone: '1' } } });
    await writeFile(join(root, 'exceptions.json'), JSON.stringify(NONE));
    const result = spawnSync(process.execPath, [gate, '--image=backend', `--project=${root}`, `--exceptions=${join(root, 'exceptions.json')}`], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not installed: gone/);
});

test('the reviewed exceptions in the repository are valid', async () => {
    const exceptions = JSON.parse(await readFile(new URL('./license-exceptions.json', import.meta.url), 'utf8'));
    assert.deepEqual(validateExceptions(exceptions), []);
});
