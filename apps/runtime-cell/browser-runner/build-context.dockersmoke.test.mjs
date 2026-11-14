import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
    cp,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Opt-in: BROWSER_CONTEXT_DOCKERSMOKE=1 BROWSER_CONTEXT_DOCKER_SOCKET=/absolute/docker.sock
// The old allowlist omitted exploration/downloader sources from the canonical COPY context.
test(
    'Docker context packages every canonical source and excludes private/operator files',
    {
        skip: process.env.BROWSER_CONTEXT_DOCKERSMOKE !== '1',
        timeout: 90_000,
    },
    async (t) => {
        const socket = process.env.BROWSER_CONTEXT_DOCKER_SOCKET;
        assert.ok(
            socket && isAbsolute(socket),
            'supply an explicit local Docker socket',
        );
        assert.ok(
            (await stat(socket)).isSocket(),
            'the selected path must be a Unix socket',
        );
        const env = {
            ...process.env,
            DOCKER_HOST: `unix://${socket}`,
            DOCKER_BUILDKIT: '0',
        };
        delete env.DOCKER_CONTEXT;
        delete env.DOCKER_TLS_VERIFY;
        delete env.DOCKER_CERT_PATH;
        const docker = (args, input) =>
            execFileSync('docker', args, {
                env,
                input,
                encoding: 'utf8',
                timeout: 30_000,
                maxBuffer: 1_048_576,
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        const source = fileURLToPath(new URL('.', import.meta.url));
        const dockerfile = await readFile(join(source, 'Dockerfile'), 'utf8');
        const required = new Set();
        for (const line of dockerfile
            .split('\n')
            .filter((line) => /^COPY\s/i.test(line))) {
            const args = line.trim().split(/\s+/).slice(1);
            if (args[0].startsWith('--from=')) continue;
            assert.ok(
                !args.some((arg) => arg.startsWith('--')),
                'local COPY flags need explicit probe support',
            );
            assert.ok(
                args.length >= 2,
                'local COPY needs sources and a destination',
            );
            for (const path of args.slice(0, -1)) {
                assert.match(
                    path,
                    /^[a-z0-9][a-z0-9.-]*$/,
                    'context sources must be explicit flat files',
                );
                required.add(path);
            }
        }
        assert.ok(
            required.size > 0,
            'the canonical Dockerfile must declare context sources',
        );

        const root = await mkdtemp(join(tmpdir(), 'kody-browser-context-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        const context = join(root, 'context'),
            output = join(root, 'output');
        const owner = randomUUID(),
            label = 'io.kodus.browser-context-test';
        const image = `kodus/browser-context-probe:${owner}`;
        let container;
        try {
            await mkdir(context);
            await mkdir(output);
            for (const entry of await readdir(source, {
                withFileTypes: true,
            })) {
                if (
                    entry.isFile() &&
                    (entry.name.endsWith('.mjs') ||
                        entry.name.endsWith('.json') ||
                        ['.dockerignore', 'Dockerfile'].includes(entry.name))
                ) {
                    await cp(
                        join(source, entry.name),
                        join(context, entry.name),
                        { force: false, errorOnExist: true },
                    );
                }
            }
            await writeFile(
                join(context, '.env.context-probe'),
                `NOT_A_SECRET=${owner}\n`,
                { flag: 'wx' },
            );
            await writeFile(
                join(context, 'operator-helper.test.mjs'),
                '// excluded operator fixture\n',
                { flag: 'wx' },
            );
            await mkdir(join(context, 'operator-private'));
            await writeFile(
                join(context, 'operator-private', 'fixture.key'),
                'not a private key\n',
                { flag: 'wx' },
            );

            // COPY the actual filtered context, not a separately reconstructed whitelist.
            // FROM scratch has no download, RUN instruction or executable workload.
            docker(
                ['build', '--network=none', '-t', image, '-f', '-', context],
                `FROM scratch\nLABEL ${label}="${owner}"\nCOPY . /probe/\n`,
            );
            assert.equal(
                docker([
                    'image',
                    'inspect',
                    '--format',
                    `{{ index .Config.Labels "${label}" }}`,
                    image,
                ]),
                owner,
            );
            container = docker([
                'create',
                '--network=none',
                '--read-only',
                '--label',
                `${label}=${owner}`,
                image,
                '/never-executed',
            ]);
            assert.match(container, /^[a-f0-9]{64}$/);
            docker(['cp', `${container}:/probe/.`, output]);
            const actual = await readdir(output, { withFileTypes: true });
            assert.ok(
                actual.every((entry) => entry.isFile()),
                'directories and symlinks must not enter the context',
            );
            assert.deepEqual(
                actual.map((entry) => entry.name).sort(),
                [...required].sort(),
                'canonical inputs must survive filtering; private/test/operator files must remain excluded',
            );
            const digest = (bytes) =>
                createHash('sha256').update(bytes).digest('hex');
            for (const name of required) {
                assert.equal(
                    digest(await readFile(join(output, name))),
                    digest(await readFile(join(source, name))),
                    `packaged source differs: ${name}`,
                );
            }
        } finally {
            if (container) {
                assert.equal(
                    docker([
                        'inspect',
                        '--format',
                        `{{ index .Config.Labels "${label}" }}`,
                        container,
                    ]),
                    owner,
                );
                docker(['rm', container]);
            }
            const ownImage = docker([
                'image',
                'ls',
                '-q',
                '--filter',
                `label=${label}=${owner}`,
            ]);
            if (ownImage) {
                assert.equal(
                    docker([
                        'image',
                        'inspect',
                        '--format',
                        `{{ index .Config.Labels "${label}" }}`,
                        image,
                    ]),
                    owner,
                );
                docker(['image', 'rm', image]);
            }
        }
    },
);
