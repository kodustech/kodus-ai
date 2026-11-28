import * as yaml from 'js-yaml';
import { posix } from 'path';

import { UNTRUSTED_YAML } from '@libs/runtime/protocol/yaml-limits';

// A repository's Cypress suite runs in its CI on one runner, where every service the app needs answers on localhost:
// the Cypress config's baseUrl, an emulator URL in Cypress env, and the URLs a front end bundles at build time all say
// localhost (kr-mono on dev: http://localhost:3000, http://localhost:9099). In the environment each service is its own
// container, so the suite runs in a service of its own (docs/runtime/e2e-suites.md section 4, `suite.service`) that
// Kody writes from `cypress/included`, which has the Cypress app, its browsers and Xvfb. Kodus makes that container
// answer localhost the way the CI runner did: it forwards each port the recipe exposes, from 127.0.0.1 in the
// container to the service that owns it, with a plain Node script (the image's own node), and keeps the container
// running for the engine's exec calls. Nothing is guessed: the ports are the recipe's own expose list.

/** The compose service the suite runs in when Kody writes one (`suite.service`). */
export const SUITE_SERVICE = 'e2e';

/** The images a suite service Kody writes is built from: Docker Hub's Cypress image with its app, browsers and Xvfb. */
const SUITE_RUNNER_IMAGE = /^\s*FROM\s+(?:--platform=\S+\s+)?(?:docker\.io\/)?cypress\/included[:@]\S+/i;
const FROM = /^\s*FROM\s/i;
const START = /^\s*(?:CMD|ENTRYPOINT)\s/i;

const FORWARD_PATH = '/usr/local/bin/kodus-localhost-forward.cjs';

/**
 * Listens on 127.0.0.1:<port> for each `host:port` argument and pipes every connection to that host and port. A port
 * already taken (two services on one port) is skipped with a line on stderr; the process stays up after that, holding
 * the container for the suite's exec calls.
 */
export const LOCALHOST_FORWARD_SCRIPT = String.raw`'use strict';
const net = require('net');
for (const arg of process.argv.slice(2)) {
  const at = arg.lastIndexOf(':');
  const host = arg.slice(0, at);
  const port = Number(arg.slice(at + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close);
    upstream.on('error', close);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.on('error', (e) => process.stderr.write('kodus: localhost:' + port + ' not forwarded to ' + host + ': ' + e.message + '\n'));
  server.listen(port, '127.0.0.1');
}
setInterval(() => {}, 1 << 30);
`;

/** A Dockerfile whose last stage is the Cypress image: the suite service's. */
export function isSuiteRunnerDockerfile(content: string): boolean {
    const froms = content.split('\n').filter((l) => FROM.test(l));
    return froms.length > 0 && SUITE_RUNNER_IMAGE.test(froms[froms.length - 1]);
}

/**
 * The suite service's Dockerfile with its last stage's CMD and ENTRYPOINT replaced by the localhost forwarder for
 * `expose` (the recipe's list, the suite service itself left out, each port once: the first service listed keeps it),
 * and what was changed. A Dockerfile that is not the suite runner's, or with no port to forward, stays as it is.
 */
export function addLocalhostForward(path: string, content: string, expose: ReadonlyArray<{ service: string; port: number }>): { content: string; changes: string[] } {
    const unchanged = { content, changes: [] };
    if (!isSuiteRunnerDockerfile(content) || content.includes(FORWARD_PATH)) return unchanged;
    const seen = new Set<number>();
    const targets: string[] = [];
    for (const e of expose) {
        if (e.service === SUITE_SERVICE || seen.has(e.port) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(e.service)) continue;
        seen.add(e.port);
        targets.push(`${e.service}:${e.port}`);
    }
    if (!targets.length) return unchanged;
    const lines = content.split('\n');
    const from = lines.map((l, i) => (FROM.test(l) ? i : -1)).filter((i) => i >= 0).at(-1)!;
    // The image's own entrypoint runs `cypress run` and exits; the engine starts the suite itself, by exec.
    const kept = [...lines.slice(0, from + 1), ...lines.slice(from + 1).filter((l) => !START.test(l))];
    while (kept.length > from + 1 && kept[kept.length - 1].trim() === '') kept.pop();
    const encoded = Buffer.from(LOCALHOST_FORWARD_SCRIPT, 'utf8').toString('base64');
    const out = [
        ...kept,
        `RUN echo ${encoded} | base64 -d > ${FORWARD_PATH}`,
        'ENTRYPOINT []',
        `CMD ${JSON.stringify(['node', FORWARD_PATH, ...targets])}`,
        '',
    ];
    return {
        content: out.join('\n'),
        changes: [
            `${path}: the suite container answers localhost as the CI runner did: Kodus forwards ${targets.map((t) => `localhost:${t.split(':')[1]} to ${t}`).join(', ')} and keeps the container running for the suite's commands`,
        ],
    };
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The suite service of the files Kody wrote: `e2e` when a compose file of theirs builds it from a Dockerfile of theirs
 * whose last stage is the Cypress image, else undefined (the suite then runs in the public service, as before).
 */
export function suiteServiceOf(files: ReadonlyArray<{ path: string; content: string }> | undefined): string | undefined {
    const byPath = new Map((files ?? []).map((f) => [posix.normalize(f.path), f.content]));
    for (const f of files ?? []) {
        if (!/\.ya?ml$/.test(f.path)) continue;
        let doc: unknown;
        try {
            doc = yaml.load(f.content, UNTRUSTED_YAML);
        } catch {
            continue;
        }
        const svc = isMap(doc) && isMap(doc.services) ? doc.services[SUITE_SERVICE] : undefined;
        const build = isMap(svc) ? svc.build : undefined;
        if (!isMap(build)) continue;
        const dockerfile = posix.normalize(posix.join(String(build.context ?? '.'), typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile'));
        const content = byPath.get(dockerfile);
        if (content !== undefined && isSuiteRunnerDockerfile(content)) return SUITE_SERVICE;
    }
    return undefined;
}
