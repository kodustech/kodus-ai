import { spawn } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

import { addLocalhostForward, isSuiteRunnerDockerfile, LOCALHOST_FORWARD_SCRIPT, suiteServiceOf } from './authored-dockerfile-e2e';
import { checkAuthoredSubmission } from './authored-files-policy';
import { appendSuiteBlock } from './suite-block';

// kr-mono on dev: a Cypress suite whose CI ran every service on localhost could not run in the app's container (no
// Cypress app, no browser) nor reach localhost:9099 from another one. The suite runs in a service Kody writes from
// cypress/included, and Kodus makes that container answer localhost for every port the recipe exposes.

const E2E_DOCKERFILE = [
    'FROM cypress/included:13.17.0',
    'WORKDIR /repo',
    'ENV CYPRESS_INSTALL_BINARY=0',
    'COPY package.json package-lock.json ./',
    'RUN npm ci',
    'COPY . .',
    'CMD ["cypress", "run"]',
].join('\n');
const EXPOSE = [
    { service: 'app', port: 3000 },
    { service: 'api', port: 5001 },
    { service: 'firebase', port: 8080 },
    { service: 'firebase', port: 9099 },
];

describe("the suite service's Dockerfile", () => {
    it('is the one whose last stage is the Cypress image', () => {
        expect(isSuiteRunnerDockerfile(E2E_DOCKERFILE)).toBe(true);
        expect(isSuiteRunnerDockerfile('FROM cypress/included:13.17.0 AS e2e\nFROM node:22\n')).toBe(false);
        expect(isSuiteRunnerDockerfile('FROM node:22-bookworm\nRUN npm ci\n')).toBe(false);
    });

    it("forwards every exposed port to its service, keeps the container running and drops the image's own cypress run", () => {
        const out = addLocalhostForward('.kodus/Dockerfile.e2e', E2E_DOCKERFILE, [...EXPOSE, { service: 'e2e', port: 4000 }, { service: 'mock', port: 3000 }]);
        const lines = out.content.trimEnd().split('\n');
        expect(lines).not.toContain('CMD ["cypress", "run"]');
        expect(lines.at(-2)).toBe('ENTRYPOINT []');
        // The suite service itself is never a target, and a port taken by an earlier service stays with it.
        expect(lines.at(-1)).toBe('CMD ["node","/usr/local/bin/kodus-localhost-forward.cjs","app:3000","api:5001","firebase:8080","firebase:9099"]');
        expect(out.changes).toEqual([expect.stringContaining('localhost:9099 to firebase:9099')]);
        // Once is enough.
        expect(addLocalhostForward('.kodus/Dockerfile.e2e', out.content, EXPOSE).changes).toEqual([]);
    });

    it('leaves any other Dockerfile as it is', () => {
        const app = 'FROM node:22\nCMD ["npm", "start"]\n';
        expect(addLocalhostForward('.kodus/Dockerfile', app, EXPOSE)).toEqual({ content: app, changes: [] });
        expect(addLocalhostForward('.kodus/Dockerfile.e2e', E2E_DOCKERFILE, [])).toEqual({ content: E2E_DOCKERFILE, changes: [] });
    });
});

describe('the localhost forwarder', () => {
    // The upstream listens on ::1 and the forwarder on 127.0.0.1, at the same port: two hosts on one machine.
    it('answers 127.0.0.1:<port> with what the service behind it answers', async () => {
        const upstream = net.createServer((c) => c.end('from the service'));
        const listening = await new Promise<boolean>((resolve) => {
            upstream.once('error', () => resolve(false));
            upstream.listen(0, '::1', () => resolve(true));
        });
        if (!listening) return; // no IPv6 loopback on this machine: nothing to run the check against.
        const port = (upstream.address() as net.AddressInfo).port;
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-forward-'));
        const script = path.join(dir, 'forward.cjs');
        await fs.writeFile(script, LOCALHOST_FORWARD_SCRIPT);
        const child = spawn(process.execPath, [script, `::1:${port}`], { stdio: 'ignore' });
        try {
            const answer = await (async () => {
                for (let i = 0; i < 50; i++) {
                    const got = await new Promise<string | null>((resolve) => {
                        const c = net.connect(port, '127.0.0.1');
                        let data = '';
                        c.on('data', (d) => (data += d.toString()));
                        c.on('end', () => resolve(data));
                        c.on('error', () => resolve(null));
                    });
                    if (got !== null) return got;
                    await new Promise((r) => setTimeout(r, 50));
                }
                return null;
            })();
            expect(answer).toBe('from the service');
        } finally {
            child.kill();
            upstream.close();
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

describe('a submission with a Cypress suite service', () => {
    const COMPOSE = 'services:\n  e2e:\n    build: { context: ., dockerfile: .kodus/Dockerfile.e2e }\n    depends_on: [app]\n';
    const RECIPE =
        'version: 1\nservices:\n  compose:\n    files: [docker-compose.yml, .kodus/compose.yaml]\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n    - { service: firebase, port: 9099, kind: http }\n';
    const REPO: Record<string, string> = {
        'docker-compose.yml': 'services:\n  app:\n    build: .\n  firebase:\n    image: node:22\n',
        Dockerfile: 'FROM node:22\nCOPY . .\nCMD ["npm", "start"]\n',
        'package.json': JSON.stringify({ name: 'shop', devDependencies: { cypress: '13.17.0' } }),
        'package-lock.json': '{}',
    };
    const files = [
        { path: '.kodus/Dockerfile.e2e', content: E2E_DOCKERFILE.replace('\nCMD ["cypress", "run"]', '') },
        { path: '.kodus/compose.yaml', content: COMPOSE },
    ];

    it("gets the forwarder for the recipe's exposed ports, and the suite block names the service", async () => {
        const r = await checkAuthoredSubmission(RECIPE, files, async (p) => p in REPO, async (p) => REPO[p] ?? null);
        expect(r.errors).toEqual([]);
        expect(r.files!.find((f) => f.path === '.kodus/Dockerfile.e2e')!.content).toContain('"app:3000","firebase:9099"');
        expect(suiteServiceOf(r.files)).toBe('e2e');

        const evidence = { suiteCandidate: { runner: 'cypress' as const, command: 'npx cypress run --spec "{specs}"', specs: 'cypress/e2e/**/*.cy.ts', source: { file: 'e2e.yml', job: 'e2e' } } } as never;
        expect(appendSuiteBlock(RECIPE, evidence, { service: 'e2e' }).recipe).toMatch(/^ {2}service: e2e$/m);
        expect(appendSuiteBlock(RECIPE, evidence).recipe).not.toMatch(/service: e2e/);
    });

    it('names no suite service when the e2e service is not built from the Cypress image', () => {
        expect(suiteServiceOf([{ path: '.kodus/Dockerfile.e2e', content: 'FROM node:22\n' }, { path: '.kodus/compose.yaml', content: COMPOSE }])).toBeUndefined();
        expect(suiteServiceOf(undefined)).toBeUndefined();
    });
});
