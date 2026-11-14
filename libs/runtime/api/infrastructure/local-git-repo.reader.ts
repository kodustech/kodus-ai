import { execFile } from 'child_process';
import { promisify } from 'util';

import type { RepoReader } from '../application/recipe-author/repo-reader';

const run = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;

/**
 * A RepoReader over a local git checkout at one commit, for the eval and the
 * dev stub: `git ls-tree` and `git show <sha>:<path>`, never the working tree.
 * Paths reach here already checked by repoPath; git gets them as arguments,
 * never through a shell.
 */
export class LocalGitRepoReader implements RepoReader {
    constructor(
        private readonly dir: string,
        private readonly sha: string,
    ) {
        if (!SHA.test(sha)) throw new Error('LocalGitRepoReader needs a 40-hex commit');
    }

    async list(dir: string): Promise<string[]> {
        try {
            const { stdout } = await run('git', ['-C', this.dir, 'ls-tree', '-z', this.sha, dir ? `${dir}/` : ''].filter(Boolean), {
                maxBuffer: 8 * 1024 * 1024,
            });
            return stdout
                .split('\0')
                .filter(Boolean)
                .map((line) => {
                    const [meta, path] = line.split('\t');
                    const name = path.slice(dir ? dir.length + 1 : 0);
                    return meta.split(' ')[1] === 'tree' ? `${name}/` : name;
                })
                .sort();
        } catch {
            return [];
        }
    }

    async read(path: string, maxBytes: number): Promise<string | null> {
        try {
            const spec = `${this.sha}:${path}`;
            const { stdout: type } = await run('git', ['-C', this.dir, 'cat-file', '-t', spec]);
            if (type.trim() !== 'blob') return null;
            const { stdout: size } = await run('git', ['-C', this.dir, 'cat-file', '-s', spec]);
            const { stdout } = await run('git', ['-C', this.dir, 'cat-file', 'blob', spec], { maxBuffer: Number(size) + 1024, encoding: 'buffer' as any });
            const buf = stdout as unknown as Buffer;
            return buf.subarray(0, maxBytes).toString('utf8');
        } catch {
            return null;
        }
    }
}
