import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
