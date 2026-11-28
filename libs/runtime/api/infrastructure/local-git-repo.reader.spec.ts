import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { WorkspaceRepoReader } from '../application/recipe-author/workspace-repo-reader';
import { LocalGitRepoReader } from './local-git-repo.reader';

describe('LocalGitRepoReader', () => {
    let dir: string;
    let sha: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'lgr-'));
        const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
        git('init', '-q');
        mkdirSync(join(dir, 'db'));
        writeFileSync(join(dir, 'db/seed.sql'), 'select 1;');
        writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
        writeFileSync(join(dir, 'big.txt'), 'a'.repeat(3 * 1024 * 1024));
        git('add', '-A');
        git('commit', '-qm', 'one');
        sha = git('rev-parse', 'HEAD');
        // The working tree moves on; the reader still sees the commit.
        writeFileSync(join(dir, 'package.json'), '{"name":"changed"}');
        writeFileSync(join(dir, 'untracked.txt'), 'no');
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('lists and reads the commit, never the working tree', async () => {
        const r = new LocalGitRepoReader(dir, sha);
        expect(await r.list('')).toEqual(['big.txt', 'db/', 'package.json']);
        expect(await r.list('db')).toEqual(['seed.sql']);
        expect(await r.read('package.json', 100)).toBe('{"name":"x"}');
        expect(await r.read('untracked.txt', 100)).toBeNull();
        expect(await r.read('db', 100)).toBeNull();
        expect(await r.read('missing', 100)).toBeNull();
    });

    it('cuts a large file at the limit instead of failing', async () => {
        const text = await new LocalGitRepoReader(dir, sha).read('big.txt', 10);
        expect(text).toBe('a'.repeat(10));
    });

    it('needs a full commit id', () => {
        expect(() => new LocalGitRepoReader(dir, 'HEAD')).toThrow();
    });
});

describe('WorkspaceRepoReader over local checkouts', () => {
    const repo = (files: Record<string, string>) => {
        const dir = mkdtempSync(join(tmpdir(), 'lgw-'));
        const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
        git('init', '-q');
        for (const [p, c] of Object.entries(files)) {
            mkdirSync(join(dir, p, '..'), { recursive: true });
            writeFileSync(join(dir, p), c);
        }
        git('add', '-A');
        git('commit', '-qm', 'one');
        return { dir, sha: git('rev-parse', 'HEAD') };
    };
    let shop: { dir: string; sha: string };
    let billing: { dir: string; sha: string };
    beforeAll(() => {
        shop = repo({ 'docker-compose.yml': 'services: {}\n', 'src/app.ts': 'x' });
        billing = repo({ Dockerfile: 'FROM golang:1.23\n', 'cmd/main.go': 'package main' });
    });
    afterAll(() => [shop, billing].forEach((r) => rmSync(r.dir, { recursive: true, force: true })));

    it('lists, reads and walks every repository at its own commit', async () => {
        const ws = new WorkspaceRepoReader({ alias: 'shop', reader: new LocalGitRepoReader(shop.dir, shop.sha) }, [
            { alias: 'billing', reader: new LocalGitRepoReader(billing.dir, billing.sha) },
        ]);
        expect(await ws.list('')).toEqual(['docker-compose.yml', 'src/']);
        expect(await ws.list('..')).toEqual(['billing/', 'shop/']);
        expect(await ws.list('../billing')).toEqual(['Dockerfile', 'cmd/']);
        expect(await ws.read('../billing/cmd/main.go', 100)).toBe('package main');
        expect(await ws.read('../shop/src/app.ts', 100)).toBe('x');
        expect(await ws.paths!()).toEqual(['docker-compose.yml', 'src/app.ts', '../billing/Dockerfile', '../billing/cmd/main.go']);
        await expect(ws.read('../other/x', 10)).rejects.toThrow('../other is not a repository of this environment');
    });
});
