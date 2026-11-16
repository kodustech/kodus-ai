import { posix } from 'path';

import { REPOSITORY_ALIAS_PATTERN } from '@libs/runtime/contracts/workspace';

import { type RepoReader, RepoPathError, repoPath } from './repo-reader';

/**
 * The recipe author's view of a multi-repository environment: one reader over
 * every repository of the workspace, each at its own commit, read only.
 *
 * Paths are seen from the primary's directory (ws/<primary>), the directory
 * the cell runs the compose project in: the primary's own files keep their
 * paths (`docker-compose.yml`, `.kodus/Dockerfile`), and another repository's
 * are `../<alias>/…`, the same spelling its compose files use to build or bind
 * that repository. So every path the single-repository author reads, writes
 * and checks means the same here, a prompt and a check written for one
 * repository stay true, and no directory of the primary can be mistaken for a
 * member (a primary with its own `billing/` beside a member aliased billing).
 * `..` lists the aliases; `../<primary>/x` is x.
 */
export interface WorkspaceReaderRepository {
    alias: string;
    reader: RepoReader;
}

/** Where a workspace path points: one repository and the path inside it, or the workspace root (`..`, directories only). */
export type WorkspaceLocation = { alias: string; path: string } | { root: true };

const plural = (aliases: readonly string[]) => aliases.map((a) => `../${a}`).join(', ');

export class WorkspaceRepoReader implements RepoReader {
    private readonly members: ReadonlyMap<string, RepoReader>;
    /** Every file path of the workspace, when every repository's reader has its whole tree in one call. */
    readonly paths?: () => Promise<string[]>;

    constructor(
        private readonly primary: WorkspaceReaderRepository,
        members: readonly WorkspaceReaderRepository[],
    ) {
        const map = new Map<string, RepoReader>();
        for (const r of [primary, ...members]) {
            if (!REPOSITORY_ALIAS_PATTERN.test(r.alias)) throw new Error(`WorkspaceRepoReader: bad alias ${JSON.stringify(r.alias)}`);
            if (map.has(r.alias)) throw new Error(`WorkspaceRepoReader: alias ${r.alias} twice`);
            map.set(r.alias, r.reader);
        }
        this.members = map;
        if ([primary, ...members].every((r) => r.reader.paths)) {
            this.paths = async () => {
                const out = [...(await primary.reader.paths!())];
                for (const m of members) for (const p of await m.reader.paths!()) out.push(`../${m.alias}/${p}`);
                return out;
            };
        }
    }

    /** The other repositories' aliases, in the order they were given. */
    get memberAliases(): string[] {
        return [...this.members.keys()].filter((a) => a !== this.primary.alias);
    }

    /**
     * A workspace path, normalized: the primary's as repoPath has it, another
     * repository's as `../<alias>/<path>`, the workspace root as `..`. Throws a
     * RepoPathError that names the repositories it could have read.
     */
    resolve(input: unknown, opts: { dir?: boolean } = {}): string {
        const at = this.locate(input, opts);
        if ('root' in at) return '..';
        if (at.alias === this.primary.alias) return at.path;
        return at.path ? `../${at.alias}/${at.path}` : `../${at.alias}`;
    }

    /** Which repository a workspace path is in, and its path there. */
    locate(input: unknown, opts: { dir?: boolean } = {}): WorkspaceLocation {
        if (typeof input !== 'string') throw new RepoPathError('the path must be a string');
        const raw = input.trim().replace(/^\.\/+/, '');
        // Spelled from the repository root: repoPath's own rules and messages, unchanged.
        const n = posix.normalize(raw || '.');
        if (n !== '..' && !n.startsWith('../')) return { alias: this.primary.alias, path: repoPath(input, opts) };
        if (raw.length > 512) throw new RepoPathError('the path is too long');
        // eslint-disable-next-line no-control-regex -- the same refusal as repoPath, before normalize drops a segment.
        if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw new RepoPathError('the path has a control character or a backslash');
        const rest = n.replace(/\/+$/, '').slice(3);
        if (!rest) {
            if (opts.dir) return { root: true };
            throw new RepoPathError(`.. is the workspace, not a file; read ../<alias>/<path> (${plural([...this.members.keys()])})`);
        }
        const slash = rest.indexOf('/');
        const alias = slash === -1 ? rest : rest.slice(0, slash);
        if (alias === '..') throw new RepoPathError(`the path leaves the workspace; the repositories are ${plural([...this.members.keys()])}`);
        if (!this.members.has(alias)) {
            throw new RepoPathError(`../${alias} is not a repository of this environment; the repositories are ${plural([...this.members.keys()])}`);
        }
        return { alias, path: repoPath(slash === -1 ? '' : rest.slice(slash + 1), { dir: opts.dir || slash === -1 }) };
    }

    private at(input: string, opts: { dir?: boolean } = {}): { reader: RepoReader; path: string } | null {
        const where = this.locate(input, opts);
        return 'root' in where ? null : { reader: this.members.get(where.alias)!, path: where.path };
    }

    async list(dir: string): Promise<string[]> {
        const at = this.at(dir, { dir: true });
        if (!at) return [...this.members.keys()].sort().map((a) => `${a}/`);
        return at.reader.list(at.path);
    }

    async read(path: string, maxBytes: number): Promise<string | null> {
        const at = this.at(path);
        if (!at || !at.path) return null;
        return at.reader.read(at.path, maxBytes);
    }

    /** Through each repository's own check; a path no repository holds is refused (RepoPathError), never "not there". */
    async exists(path: string): Promise<boolean> {
        const at = this.at(path);
        if (!at || !at.path) return false;
        return at.reader.exists ? at.reader.exists(at.path) : (await at.reader.read(at.path, 1)) !== null;
    }
}
