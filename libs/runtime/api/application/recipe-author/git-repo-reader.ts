import type { OrgTeam, RuntimeGitPort } from '../../domain/ports';
import { type RepoReader, RepoPathError, repoPath } from './repo-reader';

type Target = OrgTeam & { repositoryId: string; repositoryName: string; sha: string };

/**
 * The largest file the reader asks the Git API for. The platform refuses a
 * larger one (an error, never a cut), so a file between the agent's limit and
 * this one is read whole and cut here; past it the read fails.
 */
export const GIT_READ_MAX_BYTES = 1024 * 1024;

/** Entries of one listed directory, from the paths of the whole tree. */
function entriesOf(files: readonly string[], dir: string): string[] {
    const prefix = dir ? `${dir}/` : '';
    const out = new Set<string>();
    for (const f of files) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        out.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
    }
    return [...out].sort();
}

/** The first `maxBytes` bytes of the text (a cut UTF-8 sequence is dropped). */
function cut(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text) <= maxBytes) return text;
    return Buffer.from(text).subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
}

/**
 * The production RepoReader of Kody's recipe author: one commit of one
 * repository through the org's Git integration, read only. The tree is listed
 * once (the integration's tree API at the SHA) and each directory is cut from
 * it; files are read by readFileAtCommit at the same SHA, as the inference
 * reads them. Every path is normalized again here (S5), whatever the caller
 * already checked. A platform that cannot list or read a commit answers as
 * an error the agent sees, never as an empty repository.
 */
export class GitRepoReader implements RepoReader {
    private tree?: Promise<string[]>;

    constructor(
        private readonly git: Pick<RuntimeGitPort, 'readFileAtCommit' | 'listFilesAtCommit'>,
        private readonly target: Target,
    ) {}

    private files(): Promise<string[]> {
        this.tree ??= (async () => {
            if (!this.git.listFilesAtCommit) throw new RepoPathError('this Git platform cannot list the repository; read files by their path');
            const out = await this.git.listFilesAtCommit(this.target);
            if (out === 'unsupported_platform') throw new RepoPathError('this Git platform cannot list the repository; read files by their path');
            return out;
        })();
        // A failed listing is not kept: the next list call asks again.
        this.tree.catch(() => (this.tree = undefined));
        return this.tree;
    }

    async list(dir: string): Promise<string[]> {
        return entriesOf(await this.files(), repoPath(dir, { dir: true }));
    }

    /**
     * Answered from the tree listing (one API call for every check) when the
     * platform lists commits; else by a one-byte read. A failed listing
     * throws, never answers "not there".
     */
    async exists(path: string): Promise<boolean> {
        const p = repoPath(path);
        if (!p) return false;
        if (this.git.listFilesAtCommit) {
            const listed = await this.listed();
            if (listed) return listed.has(p);
        }
        return (await this.read(p, 1)) !== null;
    }

    private listing?: Promise<Set<string> | null>;

    /** The listed paths as a set; null when this platform cannot list a commit. */
    private listed(): Promise<Set<string> | null> {
        this.listing ??= this.files().then(
            (files) => new Set(files),
            (e: unknown) => {
                // This platform cannot list: kept. A failed listing is not: the next check asks again.
                if (e instanceof RepoPathError) return null;
                this.listing = undefined;
                throw e;
            },
        );
        return this.listing;
    }

    async read(path: string, maxBytes: number): Promise<string | null> {
        const p = repoPath(path);
        if (!p) return null;
        const text = await this.git.readFileAtCommit({ ...this.target, path: p, maxBytes: Math.max(maxBytes, GIT_READ_MAX_BYTES) });
        if (text === 'unsupported_platform') throw new RepoPathError('this Git platform cannot read a file at a commit');
        return text === null ? null : cut(text, maxBytes);
    }
}
