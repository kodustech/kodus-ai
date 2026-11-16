import { fileExists, type RepoReader, RepoPathError } from './repo-reader';
import { WorkspaceRepoReader } from './workspace-repo-reader';

/** An in-memory repository; `tree: false` gives a reader that cannot list the whole tree. */
function memory(files: Record<string, string>, opts: { tree?: boolean } = {}): RepoReader & { reads: string[] } {
    const reads: string[] = [];
    return {
        reads,
        list: async (dir) => {
            const prefix = dir ? `${dir}/` : '';
            const out = new Set<string>();
            for (const f of Object.keys(files)) {
                if (!f.startsWith(prefix)) continue;
                const rest = f.slice(prefix.length);
                out.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
            }
            return [...out].sort();
        },
        read: async (path, max) => {
            reads.push(path);
            return files[path] === undefined ? null : files[path].slice(0, max);
        },
        ...(opts.tree === false ? {} : { paths: async () => Object.keys(files).sort() }),
    };
}

const SHOP = { 'docker-compose.yml': 'services: {}\n', 'billing/notes.md': 'a directory of the primary', 'src/app.ts': 'x' };
const BILLING = { Dockerfile: 'FROM golang:1.23\n', 'go.mod': 'module billing\n', 'cmd/main.go': 'package main' };
const WEB = { 'package.json': '{}' };

const workspace = (opts: { tree?: boolean } = {}) => {
    const shop = memory(SHOP);
    const billing = memory(BILLING, opts);
    const web = memory(WEB);
    const reader = new WorkspaceRepoReader({ alias: 'shop', reader: shop }, [
        { alias: 'billing', reader: billing },
        { alias: 'web', reader: web },
    ]);
    return { reader, shop, billing, web };
};

describe('WorkspaceRepoReader', () => {
    it('keeps the primary at the root and puts every other repository at ../<alias>, so no primary directory is taken for a member', async () => {
        const { reader } = workspace();
        expect(await reader.list('')).toEqual(['billing/', 'docker-compose.yml', 'src/']);
        expect(await reader.list('billing')).toEqual(['notes.md']);
        expect(await reader.list('../billing')).toEqual(['Dockerfile', 'cmd/', 'go.mod']);
        expect(await reader.list('../billing/cmd')).toEqual(['main.go']);
        expect(await reader.list('..')).toEqual(['billing/', 'shop/', 'web/']);
        expect(reader.memberAliases).toEqual(['billing', 'web']);
    });

    it('reads each repository at its own commit; ../<primary>/x is the primary x', async () => {
        const { reader, shop, billing } = workspace();
        expect(await reader.read('../billing/go.mod', 100)).toBe('module billing\n');
        expect(await reader.read('docker-compose.yml', 100)).toBe('services: {}\n');
        expect(await reader.read('../shop/src/app.ts', 100)).toBe('x');
        expect(await reader.read('../billing/missing', 100)).toBeNull();
        expect(await reader.read('../billing', 100)).toBeNull();
        expect(billing.reads).toEqual(['go.mod', 'missing']);
        expect(shop.reads).toEqual(['docker-compose.yml', 'src/app.ts']);
        expect(await fileExists(reader, '../billing/Dockerfile')).toBe(true);
        expect(await fileExists(reader, '../web/Dockerfile')).toBe(false);
    });

    it('lists every path of the workspace, the members prefixed, when every reader has its tree', async () => {
        expect(await workspace().reader.paths!()).toEqual([
            'billing/notes.md',
            'docker-compose.yml',
            'src/app.ts',
            '../billing/Dockerfile',
            '../billing/cmd/main.go',
            '../billing/go.mod',
            '../web/package.json',
        ]);
        expect(workspace({ tree: false }).reader.paths).toBeUndefined();
    });

    it('refuses a path outside the workspace or in a repository that is not a member, naming the repositories it has', async () => {
        const { reader } = workspace();
        const refused = async (p: string, dir = false) => {
            try {
                if (dir) await reader.list(p);
                else await reader.read(p, 10);
            } catch (e) {
                expect(e).toBeInstanceOf(RepoPathError);
                return (e as Error).message;
            }
            throw new Error(`${p} was read`);
        };
        expect(await refused('../unknown/x')).toBe('../unknown is not a repository of this environment; the repositories are ../shop, ../billing, ../web');
        expect(await refused('../../etc/passwd')).toBe('the path leaves the workspace; the repositories are ../shop, ../billing, ../web');
        expect(await refused('../billing/../../x')).toContain('leaves the workspace');
        expect(await refused('..')).toContain('.. is the workspace, not a file');
        expect(await refused('../billing/.git/config')).toBe('.git is not readable');
        expect(await refused('../unknown', true)).toContain('../unknown is not a repository');
        // The primary's own paths keep repoPath's messages.
        expect(await refused('/etc/passwd')).toBe('the path must be relative to the repository root');
        expect(await refused('.git/HEAD')).toBe('.git is not readable');
        expect(await fileExists(reader, '../unknown/x')).toBe(false);
    });

    it('normalizes a path to the one spelling the checks compare', () => {
        const { reader } = workspace();
        expect(reader.resolve('./src/../docker-compose.yml')).toBe('docker-compose.yml');
        expect(reader.resolve('../shop/src')).toBe('src');
        expect(reader.resolve('../billing/./cmd/')).toBe('../billing/cmd');
        expect(reader.resolve('../billing', { dir: true })).toBe('../billing');
        expect(reader.resolve('..', { dir: true })).toBe('..');
        expect(reader.resolve('', { dir: true })).toBe('');
    });

    it('refuses an alias twice or one that is not a directory name', () => {
        const r = memory({});
        expect(() => new WorkspaceRepoReader({ alias: 'shop', reader: r }, [{ alias: 'shop', reader: r }])).toThrow('alias shop twice');
        expect(() => new WorkspaceRepoReader({ alias: 'shop', reader: r }, [{ alias: '../x', reader: r }])).toThrow('bad alias');
    });
});
