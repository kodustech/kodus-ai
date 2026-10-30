import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    toBranchName,
    type SandboxInstance,
} from '@libs/sandbox/domain/contracts/sandbox.provider';

import { normalizeRepoPath } from './knowledge-path';

/**
 * Read-only view of the PR's TARGET branch. Skills and docs are always read
 * from here, never from the head: a PR must not be able to rewrite the rules
 * it is reviewed against.
 */
export type BaseBranchReadResult =
    | { status: 'ok'; content: string }
    | { status: 'missing' }
    | { status: 'refused'; reason: string };

export interface BaseBranchReader {
    /** Branch name the reads resolve against (for messages). */
    readonly ref: string;
    readFile(path: string): Promise<BaseBranchReadResult>;
    /** Regular files under a directory, recursively, as repo-relative paths. */
    listFiles(dir: string): Promise<string[]>;
    /** Regular files on the branch matching a glob. */
    matchFiles(glob: string): Promise<string[]>;
}

/** Larger files are not knowledge, they are data: refuse rather than load. */
export const MAX_KNOWLEDGE_FILE_BYTES = 512 * 1024;

const SAFE_BRANCH = /^[A-Za-z0-9._\-/@+]+$/;
const GLOB_CHARS = /[*?[\]{}!]/;
const MODE_SYMLINK = '120000';
const MODE_SUBMODULE = '160000';

interface TreeEntry {
    mode: string;
    type: string;
    object: string;
    size: number | null;
    path: string;
}

/**
 * Reads through git objects in the sandbox (`git ls-tree` / `git cat-file` on
 * `origin/<base>`). Going through the object store instead of the working tree
 * means a symlink is just a blob holding its target text: it is refused by
 * mode, and a path through a symlinked directory does not resolve at all, so
 * nothing outside the repository can be reached.
 */
export class SandboxBaseBranchReader implements BaseBranchReader {
    readonly ref: string;
    private readonly treeish: string;

    constructor(
        private readonly sandbox: Pick<SandboxInstance, 'run' | 'repoDir'>,
        baseBranch: string,
    ) {
        const branch = toBranchName(baseBranch) ?? '';
        if (!SAFE_BRANCH.test(branch) || branch.startsWith('-')) {
            throw new Error(`unsupported base branch name: ${baseBranch}`);
        }
        this.ref = branch;
        // Fully qualified: a bare `origin/<branch>` resolves a tag of that
        // name first, and a fetch auto-follows tags onto the PR head.
        this.treeish = `refs/remotes/origin/${branch}`;
    }

    async readFile(path: string): Promise<BaseBranchReadResult> {
        const normalized = normalizeRepoPath(path);
        if (!normalized) return { status: 'refused', reason: 'invalid path' };

        const entries = await this.lsTree(normalized, false);
        const entry = entries.find((e) => e.path === normalized);
        if (!entry) return { status: 'missing' };
        if (entry.mode === MODE_SYMLINK) {
            return { status: 'refused', reason: 'symbolic links are not read' };
        }
        if (entry.type !== 'blob') return { status: 'missing' };
        if (entry.size !== null && entry.size > MAX_KNOWLEDGE_FILE_BYTES) {
            return { status: 'refused', reason: 'file too large' };
        }

        const result = await this.git(
            `cat-file blob ${shSingleQuote(entry.object)}`,
        );
        if (result.exitCode !== 0) return { status: 'missing' };
        return { status: 'ok', content: result.stdout };
    }

    async listFiles(dir: string): Promise<string[]> {
        const normalized = normalizeRepoPath(dir);
        if (!normalized) return [];
        return (await this.lsTree(`${normalized}/`, true))
            .filter(isRegularFile)
            .map((e) => e.path);
    }

    async matchFiles(glob: string): Promise<string[]> {
        const prefix = staticPrefix(glob);
        const entries = prefix
            ? await this.lsTree(`${prefix}/`, true)
            : await this.lsTree(null, true);
        return entries
            .filter(isRegularFile)
            .map((e) => e.path)
            .filter((p) => isFileMatchingGlob(p, [glob]));
    }

    private async lsTree(
        path: string | null,
        recursive: boolean,
    ): Promise<TreeEntry[]> {
        const args = [
            'ls-tree',
            '-z',
            '-l',
            '--full-tree',
            ...(recursive ? ['-r'] : []),
            shSingleQuote(this.treeish),
            '--',
            ...(path ? [shSingleQuote(path)] : []),
        ];
        const result = await this.git(args.join(' '));
        if (result.exitCode !== 0) return [];
        return parseLsTree(result.stdout);
    }

    private git(args: string) {
        return this.sandbox.run(
            `cd ${shSingleQuote(this.sandbox.repoDir)} && git ${args}`,
            { timeoutMs: 30_000 },
        );
    }
}

export function parseLsTree(output: string): TreeEntry[] {
    const entries: TreeEntry[] = [];
    for (const record of output.split('\0')) {
        const match = /^(\d+) (\w+) ([0-9a-f]+)\s+(-|\d+)\t([\s\S]+)$/.exec(
            record,
        );
        if (!match) continue;
        entries.push({
            mode: match[1],
            type: match[2],
            object: match[3],
            size: match[4] === '-' ? null : Number(match[4]),
            path: match[5],
        });
    }
    return entries;
}

function isRegularFile(entry: TreeEntry): boolean {
    return (
        entry.type === 'blob' &&
        entry.mode !== MODE_SYMLINK &&
        entry.mode !== MODE_SUBMODULE
    );
}

/** Directory part of a glob before its first wildcard (`docs/api/**` → `docs/api`). */
export function staticPrefix(glob: string): string | null {
    const segments = glob.split('/');
    const fixed: string[] = [];
    for (const segment of segments.slice(0, -1)) {
        if (GLOB_CHARS.test(segment)) break;
        fixed.push(segment);
    }
    return fixed.length ? normalizeRepoPath(fixed.join('/')) : null;
}

/**
 * Subset of the code management service this reader needs. Kept narrow so
 * the knowledge code does not depend on the whole platform facade.
 */
export interface KnowledgeCodeManagementPort {
    getRepositoryContentFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { name: string; id: string };
        file: { filename: string };
        pullRequest: { head: { ref: string }; base: { ref: string } };
    }): Promise<any>;
    getRepositoryAllFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        filters?: { branch?: string; filePatterns?: string[] };
    }): Promise<Array<{ path: string }>>;
}

/**
 * Fallback when the review has no sandbox: the provider API at the base ref.
 * Both refs of the pseudo pull request point at the base branch so providers
 * that try head first still read the target branch.
 */
export class CodeManagementBaseBranchReader implements BaseBranchReader {
    readonly ref: string;

    constructor(
        private readonly codeManagement: KnowledgeCodeManagementPort,
        private readonly params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id: string; name: string };
            baseBranch: string;
        },
    ) {
        this.ref = toBranchName(params.baseBranch) ?? params.baseBranch;
    }

    async readFile(path: string): Promise<BaseBranchReadResult> {
        const normalized = normalizeRepoPath(path);
        if (!normalized) return { status: 'refused', reason: 'invalid path' };

        let response: any;
        try {
            response = await this.codeManagement.getRepositoryContentFile({
                organizationAndTeamData: this.params.organizationAndTeamData,
                repository: this.params.repository,
                file: { filename: normalized },
                pullRequest: {
                    head: { ref: this.ref },
                    base: { ref: this.ref },
                },
            });
        } catch {
            return { status: 'missing' };
        }

        const data = response?.data;
        if (data?.type === 'symlink') {
            return { status: 'refused', reason: 'symbolic links are not read' };
        }
        if (typeof data?.content !== 'string') return { status: 'missing' };

        const content =
            data.encoding === 'base64'
                ? Buffer.from(data.content, 'base64').toString('utf-8')
                : data.content;
        if (Buffer.byteLength(content, 'utf-8') > MAX_KNOWLEDGE_FILE_BYTES) {
            return { status: 'refused', reason: 'file too large' };
        }
        return { status: 'ok', content };
    }

    async listFiles(dir: string): Promise<string[]> {
        const normalized = normalizeRepoPath(dir);
        if (!normalized) return [];
        return this.matchFiles(`${normalized}/**`);
    }

    async matchFiles(glob: string): Promise<string[]> {
        let files: Array<{ path: string }> = [];
        try {
            files = await this.codeManagement.getRepositoryAllFiles({
                organizationAndTeamData: this.params.organizationAndTeamData,
                repository: this.params.repository,
                filters: { branch: this.ref, filePatterns: [glob] },
            });
        } catch {
            return [];
        }
        // The provider filter is case-insensitive; config globs are not.
        return (files ?? [])
            .map((f) => f.path)
            .filter((p) => normalizeRepoPath(p) === p)
            .filter((p) => isFileMatchingGlob(p, [glob]));
    }
}

/**
 * The reader a review should use: the sandbox when the review has a real
 * checkout with the base fetched, the provider API otherwise.
 */
export function createBaseBranchReader(params: {
    sandbox?: Pick<SandboxInstance, 'run' | 'repoDir' | 'type'> | null;
    baseBranch: string;
    codeManagement: KnowledgeCodeManagementPort;
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id: string; name: string };
}): BaseBranchReader {
    if (params.sandbox && params.sandbox.type !== 'null') {
        try {
            return new SandboxBaseBranchReader(
                params.sandbox,
                params.baseBranch,
            );
        } catch {
            // Unusual branch name: the provider API takes it as a plain ref.
        }
    }
    return new CodeManagementBaseBranchReader(params.codeManagement, {
        organizationAndTeamData: params.organizationAndTeamData,
        repository: params.repository,
        baseBranch: params.baseBranch,
    });
}
