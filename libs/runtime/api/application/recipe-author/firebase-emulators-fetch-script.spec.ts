import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'fs';
import { createServer, Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

import { FIREBASE_EMULATORS_FETCH_SCRIPT } from './firebase-emulators-fetch-script';

// The helper a Dockerfile Kody writes runs after the install: it reads firebase-tools' own emulator table (the
// installed version's, never a hardcoded one), downloads each emulator from the cell mirror into the cache
// firebase-tools reads, under the name firebase-tools expects, and checks size and checksum like firebase-tools does.

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Entry {
    file: string;
    bucket: 'firebase-preview-drop' | 'firemat-preview-drop';
    body: Buffer;
    unzipDir?: string;
    binary?: string;
    md5?: boolean | 'wrong';
    sha256?: boolean;
}

/** A project whose node_modules holds a stand-in firebase-tools: the shape of 13.x and 14.x's getDownloadDetails. */
function project(entries: Record<string, Entry>) {
    const dir = mkdtempSync(join(tmpdir(), 'fb-fetch-'));
    const cache = join(dir, 'cache');
    const lib = join(dir, 'node_modules', 'firebase-tools', 'lib');
    mkdirSync(join(lib, 'emulator'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'firebase-tools', 'package.json'), JSON.stringify({ name: 'firebase-tools', version: '14.27.0', main: './lib/index.js' }));
    const table = Object.fromEntries(
        Object.entries(entries).map(([name, e]) => [
            name,
            {
                downloadPath: join(cache, e.file),
                ...(e.unzipDir ? { unzipDir: join(cache, e.unzipDir) } : {}),
                ...(e.binary ? { binaryPath: join(cache, e.binary) } : {}),
                opts: {
                    cacheDir: cache,
                    remoteUrl: `https://storage.googleapis.com/${e.bucket}/emulator/${e.file}`,
                    expectedSize: e.body.length,
                    ...(e.md5 === false ? {} : { expectedChecksum: e.md5 === 'wrong' ? '0'.repeat(32) : md5(e.body) }),
                    ...(e.sha256 ? { expectedChecksumSHA256: sha256(e.body) } : {}),
                },
            },
        ]),
    );
    writeFileSync(join(lib, 'emulator', 'table.json'), JSON.stringify(table));
    writeFileSync(
        join(lib, 'emulator', 'downloadableEmulators.js'),
        "const t = require('./table.json');\nexports.getDownloadDetails = (n) => { if (!t[n]) throw new Error('Invalid downloadable emulator: ' + n); return JSON.parse(JSON.stringify(t[n])); };\n",
    );
    writeFileSync(
        join(lib, 'unzip.js'),
        "const fs = require('fs'); const path = require('path');\nexports.unzip = async (file, dir) => { fs.mkdirSync(path.join(dir, 'bin'), { recursive: true }); fs.writeFileSync(path.join(dir, 'bin', 'server'), 'unzipped ' + fs.statSync(file).size); };\n",
    );
    const script = join(dir, 'fetch.cjs');
    writeFileSync(script, FIREBASE_EMULATORS_FETCH_SCRIPT);
    return { dir, cache, script };
}

function serve(files: Record<string, Buffer>): Promise<{ server: Server; base: string; requested: string[] }> {
    const requested: string[] = [];
    const server = createServer((req, res) => {
        requested.push(req.url ?? '');
        const body = files[req.url ?? ''];
        if (!body) {
            res.statusCode = 404;
            res.end('no');
            return;
        }
        res.end(body);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/artifacts/firebase-emulators`, requested })));
}

function run(p: { dir: string; script: string; cache: string }, args: string[], env: Record<string, string>) {
    return new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [p.script, ...args], { cwd: p.dir, env: { PATH: '', ...env } });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (code) => resolve({ code, out }));
    });
}

describe('the Firebase emulators helper of an authored Dockerfile', () => {
    const body = (s: string) => Buffer.from(s.repeat(50));
    let servers: Server[] = [];
    const dirs: string[] = [];
    afterEach(() => {
        servers.forEach((s) => s.close());
        servers = [];
        dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
    });

    it('fetches each emulator from the mirror under the exact name firebase-tools expects, and unpacks the zip and marks the binary executable', async () => {
        const db = { file: 'firebase-database-emulator-v4.11.2.jar', bucket: 'firebase-preview-drop', body: body('db'), sha256: true } as const;
        const ui = { file: 'ui-v1.15.0.zip', bucket: 'firebase-preview-drop', body: body('ui'), unzipDir: 'ui-v1.15.0', binary: 'ui-v1.15.0/bin/server' } as const;
        const dc = { file: 'dataconnect-emulator-linux-amd64-v2.17.3', bucket: 'firemat-preview-drop', body: body('dc') } as const;
        const p = project({ database: { ...db }, ui: { ...ui }, dataconnect: { ...dc, file: 'dataconnect-emulator-linux-amd64-v2.17.3' } });
        dirs.push(p.dir);
        // firebase-tools stores Data Connect under its own cache name, whatever the upstream file is called.
        const table = JSON.parse(readFileSync(join(p.dir, 'node_modules/firebase-tools/lib/emulator/table.json'), 'utf8'));
        table.dataconnect.downloadPath = join(p.cache, 'dataconnect-emulator-2.17.3');
        table.dataconnect.binaryPath = table.dataconnect.downloadPath;
        writeFileSync(join(p.dir, 'node_modules/firebase-tools/lib/emulator/table.json'), JSON.stringify(table));
        const m = await serve({
            '/artifacts/firebase-emulators/firebase-preview-drop/emulator/firebase-database-emulator-v4.11.2.jar': db.body,
            '/artifacts/firebase-emulators/firebase-preview-drop/emulator/ui-v1.15.0.zip': ui.body,
            '/artifacts/firebase-dataconnect/firemat-preview-drop/emulator/dataconnect-emulator-linux-amd64-v2.17.3': dc.body,
        });
        servers.push(m.server);

        const r = await run(p, ['database', 'ui', 'dataconnect'], { FIREBASE_EMULATORS_MIRROR: m.base + '/' });

        expect(r.out).toContain('database');
        expect(r.code).toBe(0);
        expect(m.requested.sort()).toEqual([
            '/artifacts/firebase-dataconnect/firemat-preview-drop/emulator/dataconnect-emulator-linux-amd64-v2.17.3',
            '/artifacts/firebase-emulators/firebase-preview-drop/emulator/firebase-database-emulator-v4.11.2.jar',
            '/artifacts/firebase-emulators/firebase-preview-drop/emulator/ui-v1.15.0.zip',
        ]);
        expect(readdirSync(p.cache).sort()).toEqual(['dataconnect-emulator-2.17.3', 'firebase-database-emulator-v4.11.2.jar', 'ui-v1.15.0', 'ui-v1.15.0.zip']);
        expect(readFileSync(join(p.cache, 'firebase-database-emulator-v4.11.2.jar'))).toEqual(db.body);
        expect(readFileSync(join(p.cache, 'ui-v1.15.0/bin/server'), 'utf8')).toContain('unzipped');
        expect(statSync(join(p.cache, 'dataconnect-emulator-2.17.3')).mode & 0o111).not.toBe(0);
        expect(statSync(join(p.cache, 'ui-v1.15.0/bin/server')).mode & 0o111).not.toBe(0);
    });

    it('fails the build when a checksum does not match, and leaves nothing in the cache', async () => {
        const db = { file: 'firebase-database-emulator-v4.11.2.jar', bucket: 'firebase-preview-drop', body: body('db'), md5: 'wrong' } as const;
        const p = project({ database: { ...db } });
        dirs.push(p.dir);
        const m = await serve({ '/artifacts/firebase-emulators/firebase-preview-drop/emulator/firebase-database-emulator-v4.11.2.jar': db.body });
        servers.push(m.server);

        const r = await run(p, ['database'], { FIREBASE_EMULATORS_MIRROR: m.base });

        expect(r.code).toBe(1);
        expect(r.out).toContain('checksum');
        expect(r.out).toContain('firebase-database-emulator-v4.11.2.jar');
        expect(existsSync(p.cache) ? readdirSync(p.cache) : []).toEqual([]);
    });

    it('fails when the size is not the one the table says, when the table has no checksum, and when the mirror answers 404', async () => {
        const short = { file: 'cloud-firestore-emulator-v1.19.8.jar', bucket: 'firebase-preview-drop', body: body('fs') } as const;
        const p = project({ firestore: { ...short } });
        dirs.push(p.dir);
        const m = await serve({ '/artifacts/firebase-emulators/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.19.8.jar': Buffer.from('short') });
        servers.push(m.server);
        const wrongSize = await run(p, ['firestore'], { FIREBASE_EMULATORS_MIRROR: m.base });
        expect(wrongSize.code).toBe(1);
        expect(wrongSize.out).toMatch(/expected \d+ bytes/);

        const bare = project({ storage: { file: 'cloud-storage-rules-runtime-v1.1.3.jar', bucket: 'firebase-preview-drop', body: body('st'), md5: false } });
        dirs.push(bare.dir);
        const m2 = await serve({ '/artifacts/firebase-emulators/firebase-preview-drop/emulator/cloud-storage-rules-runtime-v1.1.3.jar': body('st') });
        servers.push(m2.server);
        const noChecksum = await run(bare, ['storage'], { FIREBASE_EMULATORS_MIRROR: m2.base });
        expect(noChecksum.code).toBe(1);
        expect(noChecksum.out).toContain('no checksum');

        const gone = await run(p, ['firestore'], { FIREBASE_EMULATORS_MIRROR: m.base.replace('/firebase-emulators', '/nothing') });
        expect(gone.code).toBe(1);
        expect(gone.out).toContain('404');
    });

    it('names the emulator it does not know, and says where it looked when firebase-tools is not installed', async () => {
        const p = project({ database: { file: 'firebase-database-emulator-v4.11.2.jar', bucket: 'firebase-preview-drop', body: body('db') } });
        dirs.push(p.dir);
        const unknown = await run(p, ['nothing'], { FIREBASE_EMULATORS_MIRROR: 'http://127.0.0.1:9/artifacts/firebase-emulators' });
        expect(unknown.code).toBe(1);
        expect(unknown.out).toContain('nothing');
        rmSync(join(p.dir, 'node_modules'), { recursive: true });
        const none = await run(p, ['database'], { FIREBASE_EMULATORS_MIRROR: 'http://127.0.0.1:9/artifacts/firebase-emulators' });
        expect(none.code).toBe(1);
        expect(none.out).toContain('firebase-tools is not installed');
    });

    it('does nothing when the cell serves no mirror (firebase-tools downloads the emulators itself)', async () => {
        const p = project({ database: { file: 'firebase-database-emulator-v4.11.2.jar', bucket: 'firebase-preview-drop', body: body('db') } });
        dirs.push(p.dir);
        const r = await run(p, ['database'], {});
        expect(r.code).toBe(0);
        expect(existsSync(p.cache)).toBe(false);
    });
});
