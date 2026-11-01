import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    toBranchName,
    type SandboxInstance,
} from '@libs/sandbox/domain/contracts/sandbox.provider';

import { parseKnowledgeSourcePath } from '@libs/core/infrastructure/config/types/general/codeReview.type';

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
    /** Branch a given path is read on, for messages: `ref`, except for a
     *  skill or doc of another repository (`owner/repo:path`). */
    refFor?(path: string): string;
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
    /** The repositories the team's integration reaches, to find another
     *  repository a skill or doc lives in. */
    getRepositories?(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<KnowledgeRepositoryListing[]>;
}

/** What a repository listing carries that knowledge needs. */
export interface KnowledgeRepositoryListing {
    id: string | number;
    name: string;
    full_name?: string;
    default_branch?: string;
    visibility?: 'public' | 'private';
    http_url?: string;
}

/** Another repository skills or docs are read from, at one ref. */
export interface KnowledgeRepositorySource {
    /** `owner/repo` as the provider spells it. */
    fullName: string;
    id: string;
    name: string;
    /** Branch or tag the files are read at: the configured ref, else the
     *  repository's default branch. */
    ref: string;
    visibility?: 'public' | 'private';
    httpUrl?: string;
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

/**
 * The reviewed repository's reader plus one per other repository the linked
 * skills and docs live in. A path `owner/repo:path` names a file of that
 * repository, read through the provider API at its source's ref; anything
 * else is a path of the reviewed repository. Only the repositories the
 * config names can be reached: a qualified path to any other one is refused,
 * so neither the model (readSkillFile) nor a quote can open a repository the
 * team did not link.
 */
export class MultiRepositoryKnowledgeReader implements BaseBranchReader {
    readonly ref: string;
    private readonly byRepository = new Map<
        string,
        { source: KnowledgeRepositorySource; reader: BaseBranchReader }
    >();

    constructor(
        private readonly local: BaseBranchReader,
        sources: ReadonlyArray<{
            source: KnowledgeRepositorySource;
            reader: BaseBranchReader;
        }>,
    ) {
        this.ref = local.ref;
        for (const entry of sources) {
            this.byRepository.set(entry.source.fullName.toLowerCase(), entry);
        }
    }

    /** The other repository a qualified path names, when it is linked. */
    sourceOf(path: string): KnowledgeRepositorySource | undefined {
        const parsed = parseKnowledgeSourcePath(path);
        return parsed
            ? this.byRepository.get(parsed.repository.toLowerCase())?.source
            : undefined;
    }

    get sources(): KnowledgeRepositorySource[] {
        return [...this.byRepository.values()].map((entry) => entry.source);
    }

    refFor(path: string): string {
        return (
            this.sourceOf(path)?.ref ?? this.local.refFor?.(path) ?? this.ref
        );
    }

    async readFile(path: string): Promise<BaseBranchReadResult> {
        const route = this.route(path);
        if (route === 'refused') {
            return {
                status: 'refused',
                reason: 'not a repository linked to these skills and docs',
            };
        }
        return route
            ? route.reader.readFile(route.path)
            : this.local.readFile(path);
    }

    async listFiles(dir: string): Promise<string[]> {
        const route = this.route(dir);
        if (route === 'refused') return [];
        if (!route) return this.local.listFiles(dir);
        return (await route.reader.listFiles(route.path)).map(
            (p) => `${route.prefix}${p}`,
        );
    }

    async matchFiles(glob: string): Promise<string[]> {
        const route = this.route(glob);
        if (route === 'refused') return [];
        if (!route) return this.local.matchFiles(glob);
        return (await route.reader.matchFiles(route.path)).map(
            (p) => `${route.prefix}${p}`,
        );
    }

    private route(
        path: string,
    ):
        | { reader: BaseBranchReader; path: string; prefix: string }
        | 'refused'
        | null {
        const parsed = parseKnowledgeSourcePath(path);
        if (!parsed) return null;
        const entry = this.byRepository.get(parsed.repository.toLowerCase());
        if (!entry) return 'refused';
        return {
            reader: entry.reader,
            path: parsed.path,
            // The spelling the config used, so paths read back match it.
            prefix: `${path.slice(0, path.indexOf(':'))}:`,
        };
    }
}

/**
 * Finds each repository the items name among the ones the integration
 * reaches and builds its reader at the item's ref (else its default branch).
 * A repository it cannot find is returned in `missing`; its items then read
 * as not found.
 */
export async function resolveKnowledgeRepositories(params: {
    items: ReadonlyArray<{ repository?: string; ref?: string }>;
    codeManagement: KnowledgeCodeManagementPort;
    organizationAndTeamData: OrganizationAndTeamData;
}): Promise<{
    sources: Array<{
        source: KnowledgeRepositorySource;
        reader: BaseBranchReader;
    }>;
    missing: string[];
    listing: KnowledgeRepositoryListing[];
}> {
    const wanted = new Map<string, { repository: string; ref?: string }>();
    for (const item of params.items) {
        if (!item.repository) continue;
        const key = item.repository.toLowerCase();
        const seen = wanted.get(key);
        if (!seen)
            wanted.set(key, { repository: item.repository, ref: item.ref });
        else if (!seen.ref && item.ref) seen.ref = item.ref;
    }
    if (!wanted.size) return { sources: [], missing: [], listing: [] };

    const listing: KnowledgeRepositoryListing[] =
        (await params.codeManagement
            .getRepositories?.({
                organizationAndTeamData: params.organizationAndTeamData,
            })
            .catch(() => undefined)) ?? [];
    const byName = new Map<string, KnowledgeRepositoryListing>();
    for (const repo of listing) {
        const fullName = repo.full_name || repo.name;
        if (fullName) byName.set(fullName.toLowerCase(), repo);
    }

    const sources: Array<{
        source: KnowledgeRepositorySource;
        reader: BaseBranchReader;
    }> = [];
    const missing: string[] = [];
    for (const [key, { repository, ref }] of wanted) {
        const repo = byName.get(key);
        if (!repo) {
            missing.push(repository);
            continue;
        }
        const readAt = ref || repo.default_branch || 'main';
        const source: KnowledgeRepositorySource = {
            fullName: repository,
            id: String(repo.id),
            name: repo.name,
            ref: readAt,
            visibility: repo.visibility,
            httpUrl: repo.http_url,
        };
        sources.push({
            source,
            reader: new CodeManagementBaseBranchReader(params.codeManagement, {
                organizationAndTeamData: params.organizationAndTeamData,
                repository: { id: source.id, name: source.name },
                baseBranch: readAt,
            }),
        });
    }
    return { sources, missing, listing };
}
