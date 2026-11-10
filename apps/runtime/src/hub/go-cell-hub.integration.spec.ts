import 'reflect-metadata';

import { ChildProcess, execFileSync, spawn, spawnSync } from 'child_process';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { AddressInfo, createServer as netServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';

import { loadRuntimeConfig } from '../shared/config';
import { mtlsPost } from '../worker/env/hub-environment-runtime';
import { issueClientCert, normalizeSerial } from './ca/x509';
import { createRuntimeHubApp, listenRuntimeHub } from './hub-app';

// The real Go cell (fake driver) against the real TS runtime-hub over mTLS
// with certificates from scripts/runtime/dev-ca.sh: hello (ack.version) →
// claim.acquire → claim.ready (resent until acked) → egress.policy with the
// approved hosts → probe.run → step.result → release, and a managed cell that
// renews its certificate on its own, keeps its live claim and reconnects with
// the renewed certificate after a hub restart.
// Needs go and docker (Postgres in a throwaway container); skipped without them.

const ROOT = resolve(__dirname, '../../../..');
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const enabled = has('go', ['version']) && has('docker', ['info']) && has('openssl', ['version']);
const PG = 'kr-int-protocol-pg';
const CELL = 'cell-e2e-1';
const SHA = 'b'.repeat(40);

const freePort = () =>
    new Promise<number>((ok) => {
        const s = netServer().listen(0, '127.0.0.1', () => {
            const p = (s.address() as AddressInfo).port;
            s.close(() => ok(p));
        });
    });
const logLine = (log: string, ...parts: string[]) => log.split('\n').find((l) => parts.every((p) => l.includes(p)));
const until = async <T>(what: string, f: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
        const v = await f().catch(() => undefined);
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 200));
    }
};

(enabled ? describe : describe.skip)('Go cell ↔ TS hub over mTLS', () => {
    jest.setTimeout(240_000);
    let dir: string;
    let certs: string;
    let app: INestApplication | undefined;
    let cell: ChildProcess | undefined;
    let cell2: ChildProcess | undefined;
    let cellLog = '';
    let cell2Log = '';
    let servers: Server[] = [];
    let hubPort: number;
    let internalPort: number;
    let listeners: { close: () => Promise<void> } | undefined;
    let targetPort: number;
    let pgUrl: string;
    let gitApi: string;

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'kr-go-hub-'));
        certs = join(dir, 'certs');
        execFileSync(join(ROOT, 'scripts/runtime/dev-ca.sh'), [certs, CELL], { stdio: 'ignore' });

        spawnSync('docker', ['rm', '-f', '-v', PG], { stdio: 'ignore' });
        execFileSync('docker', ['run', '-d', '--name', PG, '-e', 'POSTGRES_USER=runtime', '-e', 'POSTGRES_PASSWORD=runtime', '-e', 'POSTGRES_DB=kodus_runtime', '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16'], { stdio: 'ignore' });
        const port = execFileSync('docker', ['port', PG, '5432/tcp']).toString().trim().split(':').pop();
        pgUrl = `postgres://runtime:runtime@127.0.0.1:${port}/kodus_runtime`;
        await until('postgres', async () => {
            const p = new Pool({ connectionString: pgUrl, max: 1 });
            try {
                await p.query('SELECT 1');
                return true;
            } finally {
                await p.end();
            }
        }, 60_000);

        execFileSync('go', ['build', '-o', join(dir, 'cell'), './cmd/cell'], { cwd: join(ROOT, 'apps/runtime-cell'), stdio: 'ignore' });

        // A GitHub stand-in: the tarball of the repo at SHA and the token revocation.
        const src = join(dir, 'src', `acme-shop-${SHA.slice(0, 7)}`);
        mkdirSync(src, { recursive: true });
        writeFileSync(join(src, 'README.md'), 'shop\n');
        execFileSync('tar', ['-czf', join(dir, 'repo.tgz'), '-C', join(dir, 'src'), `acme-shop-${SHA.slice(0, 7)}`], {
            // No AppleDouble (._*) entries from macOS tar: the cell refuses files at the archive root.
            env: { ...process.env, COPYFILE_DISABLE: '1' },
        });
        const git = createServer((req, res) => {
            if (req.method === 'GET' && req.url === `/repos/acme/shop/tarball/${SHA}`) {
                res.writeHead(200, { 'content-type': 'application/x-gzip' });
                return res.end(readFileSync(join(dir, 'repo.tgz')));
            }
            if (req.method === 'DELETE' && req.url === '/installation/token') return res.writeHead(204).end();
            res.writeHead(404).end();
        });
        // The "app" in the workload: the fake driver's machines answer on 127.0.0.1.
        const target = createServer((req, res) => res.writeHead(req.method === 'POST' && req.url === '/orders' ? 400 : 200).end('{}'));
        servers = [git, target];
        await Promise.all(servers.map((s) => new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))));
        targetPort = (target.address() as AddressInfo).port;
        gitApi = `http://127.0.0.1:${(git.address() as AddressInfo).port}`;

        hubPort = await freePort();
        internalPort = await freePort();
        const env = Object.fromEntries(
            readFileSync(join(certs, 'hub.env'), 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
        );
        Object.assign(process.env, env, {
            RUNTIME_DATABASE_URL: pgUrl,
            RUNTIME_HUB_PORT: String(hubPort),
            RUNTIME_HUB_INTERNAL_PORT: String(internalPort),
            // The Go fake driver reports isolation 'none' (no VM): accepted only with the dev flag.
            RUNTIME_DEV_ALLOW_INSECURE_CELLS: '1',
            RUNTIME_REPLICA_URL: `https://127.0.0.1:${internalPort}`,
            RUNTIME_STREAM_DIR: join(dir, 'streams'),
        });
        delete process.env.RUNTIME_TEST_ONLY_PLAINTEXT;
        app = (await createRuntimeHubApp(loadRuntimeConfig(), ['warn', 'error'])).app;
        listeners = await listenRuntimeHub(app, loadRuntimeConfig(), '127.0.0.1');

        cell = spawn(
            join(dir, 'cell'),
            [
                '-hub-url', `wss://127.0.0.1:${hubPort}/cells`,
                '-cell-id', CELL,
                '-cert', join(certs, 'cell.pem'),
                '-key', join(certs, 'cell.key'),
                '-ca', join(certs, 'ca.pem'),
                '-driver', 'fake',
                '-observer', 'inprocess',
                '-workdir', join(dir, 'work'),
                '-git-api', gitApi,
                '-dev',
                // The dev stack's hub may hold the default metrics port: the cells under test serve none.
                '-metrics-addr', 'off',
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        cell.stderr!.on('data', (d) => (cellLog += d.toString()));
    });

    afterAll(async () => {
        cell?.kill('SIGTERM');
        cell2?.kill('SIGTERM');
        await listeners?.close().catch(() => undefined);
        await app?.close().catch(() => undefined);
        for (const s of servers) s.close();
        spawnSync('docker', ['rm', '-f', '-v', PG], { stdio: 'ignore' });
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    const worker = () => {
        const post = mtlsPost({ cert: readFileSync(join(certs, 'worker.pem'), 'utf8'), key: readFileSync(join(certs, 'worker.key'), 'utf8'), ca: readFileSync(join(certs, 'ca.pem'), 'utf8') });
        return async (path: string, body: unknown) => {
            const r = await post(`https://127.0.0.1:${internalPort}${path}`, { 'content-type': 'application/json' }, JSON.stringify(body), 120_000);
            return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
        };
    };

    it('runs hello → claim.acquire → claim.ready → probe.run → step.result → release', async () => {
        const call = worker();
        const db = new Pool({ connectionString: pgUrl, max: 1 });
        // hello acked with the version: the cell logs it and the session row exists.
        await until('the cell session', async () => {
            const p = new Pool({ connectionString: pgUrl, max: 1 });
            try {
                const r = await p.query(`SELECT 1 FROM runtime.runtime_cell_sessions WHERE cell_id = $1 AND disconnected_at IS NULL`, [CELL]);
                return r.rowCount === 1;
            } finally {
                await p.end();
            }
        }).catch((e) => {
            throw new Error(`${(e as Error).message}\ncell log:\n${cellLog.split('\n').slice(-12).join('\n')}`);
        });
        expect(cellLog).toMatch(/"msg":"hub.connected"/);
        expect(cellLog).toMatch(/"version":1/);
        // Approved before the claim exists: the claim gets it right after claim.ready.
        await db.query(
            `INSERT INTO runtime.runtime_egress_approvals (environment_id, host, organization_id, approved_by, approved_at)
             VALUES ('shop', 'api.stripe.com', 'org-e2e', 'admin', now()), ('shop', 'registry.npmjs.org', 'org-e2e', 'admin', now())`,
        );

        const acquired = await call(`/internal/cells/${CELL}/acquire`, {
            organizationId: 'org-e2e',
            environmentId: 'shop',
            runId: 'run-e2e',
            imageId: 'img-e2e',
            ref: { side: 'base', sha: SHA },
            consumer: 'runtime',
            idempotencyKey: `run-e2e:${randomUUID()}`,
            expose: [{ service: 'web', port: targetPort, kind: 'http' }],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: gitApi },
            repoToken: 'ghs_e2e',
        });
        expect(acquired.status).toBe(200);
        const claim = acquired.body;
        // Bound only on claim.ready: the manifest and observer come from the Go cell.
        if (!claim.claimId) throw new Error(`acquire: ${JSON.stringify(claim)}\ncell log:\n${cellLog.split('\n').filter((l) => /claim|error|warn/i.test(l)).slice(-8).join('\n')}`);
        expect(claim.claimId).toMatch(/^claim-/);
        expect(claim.manifest.expose).toEqual([{ service: 'web', port: targetPort, kind: 'http' }]);
        expect(claim.observer.state).toBe('ready');
        expect(claim.observer.id).not.toBe(`${claim.claimId}-observer`);
        expect(claim.timing.prepareMs).toBeGreaterThanOrEqual(0);
        // Per-claim log lines of the cell carry the cell, the claim and the Run, never the token.
        // (The hub's ack of claim.ready shows below: the claim is bound and gets its egress.policy.)
        for (const msg of ['claim.acquire', 'claim.phase', 'claim.ready']) {
            if (!logLine(cellLog, `"msg":"${msg}"`, `"cell":"${CELL}"`, `"claim":"${claim.claimId}"`, '"run":"run-e2e"')) {
                throw new Error(`no ${msg} line for the claim; cell log:\n${cellLog.split('\n').filter((l) => l.includes(claim.claimId)).slice(0, 8).join('\n')}`);
            }
        }
        await until('egress.policy on the cell', async () => logLine(cellLog, '"msg":"egress.policy"', `"claim":"${claim.claimId}"`, '"hosts":2'), 10_000);
        expect(cellLog).not.toContain('ghs_e2e');

        const probed = await call(`/internal/claims/${claim.claimId}/probe`, {
            organizationId: 'org-e2e',
            stepId: randomUUID(),
            probe: {
                id: 'p1',
                origin: 'agent',
                purpose: 'order without items is refused',
                expected: '400',
                compare: ['status'],
                spec: { kind: 'http', target: { service: 'web', port: targetPort }, method: 'POST', path: '/orders', timeoutMs: 5_000 },
            },
        });
        expect(probed.status).toBe(200);
        expect(probed.body).toMatchObject({ http: { status: 400 }, vmHealth: 'ok' });

        expect((await call(`/internal/claims/${claim.claimId}/release`, { organizationId: 'org-e2e' })).body).toEqual({ ok: true });
        await until('claim.release on the cell', async () => logLine(cellLog, '"msg":"claim.release"', `"claim":"${claim.claimId}"`), 10_000);
        await db.end();
    });

    it('refuses a worker certificate on /cells, internal routes on the public port, and a missing certificate on the internal port', async () => {
        const status = (port: number, extra: Record<string, unknown> = {}) =>
            new Promise<number | string>((ok) => {
                const req = httpsRequest(
                    { host: '127.0.0.1', port, path: `/internal/claims/x/release`, method: 'POST', ca: readFileSync(join(certs, 'ca.pem')), headers: { 'content-type': 'application/json' }, ...extra },
                    (res) => ok(res.statusCode ?? 0),
                );
                req.on('error', (e) => ok(`refused: ${e.message}`));
                req.end('{}');
            });
        // The public listener does not serve internal routes, even with a worker certificate.
        expect(await status(hubPort, { cert: readFileSync(join(certs, 'worker.pem')), key: readFileSync(join(certs, 'worker.key')) })).toBe(404);
        // The internal listener requires a client certificate at the handshake.
        expect(await status(internalPort)).toMatch(/^refused/);
        const asWorker = await new Promise<number>((ok, ko) => {
            const req = httpsRequest(
                {
                    host: '127.0.0.1',
                    port: hubPort,
                    path: '/cells',
                    ca: readFileSync(join(certs, 'ca.pem')),
                    cert: readFileSync(join(certs, 'worker.pem')),
                    key: readFileSync(join(certs, 'worker.key')),
                    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.from(randomUUID().slice(0, 16)).toString('base64') },
                },
                (res) => ok(res.statusCode ?? 0),
            );
            req.on('upgrade', () => ok(101));
            req.on('error', ko);
            req.end();
        });
        expect(asWorker).toBe(401);
    });

    it('a revoked cell is dropped and its certificate refused at the TLS handshake', async () => {
        const p = new Pool({ connectionString: pgUrl, max: 1 });
        try {
            await p.query(`UPDATE runtime.runtime_cells SET status = 'revoked' WHERE cell_id = $1`, [CELL]);
            await until('the cell dropped', async () => {
                const r = await p.query(`SELECT 1 FROM runtime.runtime_cell_sessions WHERE cell_id = $1 AND disconnected_at IS NULL`, [CELL]);
                return r.rowCount === 0;
            });
        } finally {
            await p.end();
        }
        const outcome = await new Promise<string>((ok) => {
            const req = httpsRequest(
                {
                    host: '127.0.0.1',
                    port: hubPort,
                    path: '/health',
                    ca: readFileSync(join(certs, 'ca.pem')),
                    cert: readFileSync(join(certs, 'cell.pem')),
                    key: readFileSync(join(certs, 'cell.key')),
                },
                (res) => ok(`http ${res.statusCode}`),
            );
            req.on('error', (e) => ok(`refused: ${e.message}`));
            req.end();
        });
        expect(outcome).toMatch(/^refused/);
        expect(cellLog).toMatch(/cell\.revoked|hub\.disconnected/);
    });

    it('a managed cell renews its certificate on its own, keeps its live claim, and reconnects with it after a hub restart', async () => {
        const call = worker();
        const CELL2 = 'cell-e2e-renew';
        const certs2 = join(dir, 'certs2');
        mkdirSync(certs2, { mode: 0o700 });
        copyFileSync(join(certs, 'ca.pem'), join(certs2, 'ca.pem'));
        // A certificate whose last third starts ~15 s from now (1 h + the CA's 5 min backdate).
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const validityMs = 65 * 60_000;
        const renewAt = Date.now() + 15_000;
        const notAfter = renewAt + validityMs / 3;
        const issued = issueClientCert(
            { certPem: readFileSync(join(certs, 'ca.pem'), 'utf8'), keyPem: readFileSync(join(certs, 'ca.key'), 'utf8') },
            publicKey.export({ type: 'spki', format: 'der' }),
            { commonName: CELL2, role: 'cell', hours: 1, now: new Date(notAfter - 3_600_000) },
        );
        writeFileSync(join(certs2, 'cell.pem'), issued.certPem);
        writeFileSync(join(certs2, 'cell.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
        const first = normalizeSerial(issued.serial);
        // The row RUNTIME_MANAGED_CELLS gives a managed cell, and the same config for the next boot.
        const db = new Pool({ connectionString: pgUrl, max: 1 });
        await db.query(
            `INSERT INTO runtime.runtime_cells (cell_id, organization_id, owner, topology, status, certificate_serial, certificate_expires_at, managed_serial)
             VALUES ($1, NULL, 'kodus', 'managed', 'disconnected', $2, $3, $2)`,
            [CELL2, first, issued.notAfter.toISOString()],
        );
        process.env.RUNTIME_MANAGED_CELLS = JSON.stringify({ ...JSON.parse(process.env.RUNTIME_MANAGED_CELLS ?? '{}'), [CELL2]: issued.serial });
        const pin = async () => (await db.query(`SELECT certificate_serial FROM runtime.runtime_cells WHERE cell_id = $1`, [CELL2])).rows[0]?.certificate_serial;
        const session = async () => (await db.query(`SELECT 1 FROM runtime.runtime_cell_sessions WHERE cell_id = $1 AND disconnected_at IS NULL`, [CELL2])).rowCount === 1;
        const startCell2 = () => {
            const p = spawn(
                join(dir, 'cell'),
                ['-hub-url', `wss://127.0.0.1:${hubPort}/cells`, '-cell-id', CELL2, '-cert', join(certs2, 'cell.pem'), '-key', join(certs2, 'cell.key'), '-ca', join(certs2, 'ca.pem'),
                    '-driver', 'fake', '-observer', 'inprocess', '-workdir', join(dir, 'work2'), '-git-api', gitApi, '-dev', '-metrics-addr', 'off'],
                { stdio: ['ignore', 'ignore', 'pipe'] },
            );
            p.stderr!.on('data', (d) => (cell2Log += d.toString()));
            return p;
        };
        const stop = (p: ChildProcess | undefined) =>
            new Promise<void>((ok) => {
                if (!p || p.exitCode !== null) return ok();
                p.once('exit', () => ok());
                p.kill('SIGTERM');
            });
        try {
            cell2 = startCell2();
            await until('cell2 session', session);
            expect(logLine(cell2Log, '"msg":"cert.renew.scheduled"', `"cell":"${CELL2}"`)).toBeDefined();

            const acquired = await call(`/internal/cells/${CELL2}/acquire`, {
                organizationId: 'org-e2e',
                environmentId: 'shop',
                runId: 'run-renew',
                imageId: 'img-e2e',
                ref: { side: 'base', sha: SHA },
                consumer: 'runtime',
                idempotencyKey: `run-renew:${randomUUID()}`,
                expose: [{ service: 'web', port: targetPort, kind: 'http' }],
                repo: { provider: 'github', fullName: 'acme/shop', apiBase: gitApi },
                repoToken: 'ghs_e2e',
            });
            expect(acquired.body.claimId).toMatch(/^claim-/);

            await until('cert.renewed', async () => logLine(cell2Log, '"msg":"cert.renewed"', `"cell":"${CELL2}"`), 60_000);
            const renewed = await pin();
            expect(renewed).not.toBe(first);
            expect(normalizeSerial(execFileSync('openssl', ['x509', '-in', join(certs2, 'cell.pem'), '-noout', '-serial']).toString().split('=')[1])).toBe(renewed);
            expect(cell2Log).not.toContain('PRIVATE KEY');

            // The live connection, and its claim, went on through the renewal.
            const probed = await call(`/internal/claims/${acquired.body.claimId}/probe`, {
                organizationId: 'org-e2e',
                stepId: randomUUID(),
                probe: { id: 'p2', origin: 'agent', purpose: 'still there', expected: '200', compare: ['status'], spec: { kind: 'http', target: { service: 'web', port: targetPort }, method: 'GET', path: '/', timeoutMs: 5_000 } },
            });
            expect(probed.body).toMatchObject({ http: { status: 200 }, vmHealth: 'ok' });
            expect(cell2Log.split('\n').filter((l) => l.includes('"msg":"hub.connected"'))).toHaveLength(1);

            // Hub restart with the same RUNTIME_MANAGED_CELLS: the renewed pin stays and the cell gets back in with the renewed files.
            await stop(cell2);
            await stop(cell);
            await listeners!.close();
            await app!.close();
            app = (await createRuntimeHubApp(loadRuntimeConfig(), ['warn', 'error'])).app;
            listeners = await listenRuntimeHub(app, loadRuntimeConfig(), '127.0.0.1');
            expect(await pin()).toBe(renewed);
            cell2Log = '';
            cell2 = startCell2();
            await until('cell2 back with the renewed certificate', async () => logLine(cell2Log, '"msg":"hub.connected"'));
            expect(await session()).toBe(true);
        } finally {
            await db.end();
        }
    });
});
