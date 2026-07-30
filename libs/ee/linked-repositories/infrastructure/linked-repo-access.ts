import { createLogger } from '@libs/core/log/logger';
import { PlatformType } from '@libs/core/domain/enums';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import type {
    CrossRepoGateMetadata,
    LinkedRepoAccess,
    LinkedRepositoriesReviewMetadata,
    ResolvedLinkedRepository,
} from '../domain/linked-repository.types';

const logger = createLogger('LinkedRepoAccess');

const CLONE_TIMEOUT_MS = 180_000; // 3 min per linked repo

export type LinkedRepoCloneParams = {
    url: string;
    authToken: string;
    authUsername?: string;
    platform: PlatformType;
};

export type LinkedRepoAccessDeps = {
    sandbox: SandboxInstance;
    resolved: ResolvedLinkedRepository[];
    warnings: string[];
    /** Deterministic boundary-gate decision (recorded in review metadata). */
    gate?: CrossRepoGateMetadata;
    /**
     * Resolve clone auth/url for a linked repository. Called lazily on first
     * tool access. Must NOT throw for auth misses — return null instead.
     */
    getCloneParams: (
        repo: ResolvedLinkedRepository,
    ) => Promise<LinkedRepoCloneParams | null>;
};

/**
 * Lazy sibling-clone manager for cross-repo agent tools (#1576).
 *
 * - Clones into `<sandbox>/_linked/<slug>` on first `ensureCloned` call.
 * - Ref cascade (in order): PR-description override → config pin → open PR on
 *   matching head branch → head branch → default → main/master.
 * - Failures are non-blocking; status is recorded for review metadata.
 */
export class LazyLinkedRepoAccess implements LinkedRepoAccess {
    private readonly byKey = new Map<string, ResolvedLinkedRepository>();
    private readonly cloneInflight = new Map<
        string,
        Promise<
            | { ok: true; rootPath: string; repository: string; ref: string }
            | { ok: false; error: string }
        >
    >();
    private readonly warnings: string[];

    constructor(private readonly deps: LinkedRepoAccessDeps) {
        this.warnings = [...(deps.warnings || [])];
        for (const repo of deps.resolved) {
            this.index(repo);
        }
    }

    list() {
        // Dedupe by fullName (index stores multiple keys per repo).
        const seen = new Set<string>();
        const out: Array<{
            repository: string;
            instructions?: string;
            preferredRef: string;
            status: ResolvedLinkedRepository['status'];
        }> = [];
        for (const repo of this.deps.resolved) {
            const k = repo.fullName.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({
                repository: repo.fullName,
                instructions: repo.instructions,
                preferredRef: repo.preferredRef,
                status: repo.status,
            });
        }
        return out;
    }

    async ensureCloned(repoKey: string) {
        const repo = this.lookup(repoKey);
        if (!repo) {
            return {
                ok: false as const,
                error: `Unknown linked repository "${repoKey}". Allowed: ${this.list()
                    .map((r) => r.repository)
                    .join(', ') || '(none)'}`,
            };
        }

        if (repo.status === 'ready' && repo.resolvedRef) {
            return {
                ok: true as const,
                rootPath: repo.rootPath,
                repository: repo.fullName,
                ref: repo.resolvedRef,
            };
        }

        if (repo.status === 'failed') {
            return {
                ok: false as const,
                error:
                    repo.reason ||
                    `Previously failed to clone ${repo.fullName}`,
            };
        }

        const existing = this.cloneInflight.get(repo.fullName);
        if (existing) return existing;

        const promise = this.cloneRepo(repo);
        this.cloneInflight.set(repo.fullName, promise);
        try {
            return await promise;
        } finally {
            this.cloneInflight.delete(repo.fullName);
        }
    }

    getMetadata(): LinkedRepositoriesReviewMetadata {
        const seen = new Set<string>();
        const repositories: LinkedRepositoriesReviewMetadata['repositories'] =
            [];
        for (const repo of this.deps.resolved) {
            const k = repo.fullName.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            repositories.push({
                repository: repo.fullName,
                ref: repo.resolvedRef || repo.preferredRef,
                source: repo.resolvedSource,
                prNumber: repo.resolvedPrNumber,
                status: repo.status,
                reason: repo.reason,
            });
        }
        return {
            configured: this.deps.resolved.length,
            resolved: repositories.filter((r) => r.status !== 'skipped')
                .length,
            cloned: repositories.filter((r) => r.status === 'ready').length,
            failed: repositories.filter((r) => r.status === 'failed').length,
            warnings: [...this.warnings],
            gate: this.deps.gate,
            repositories,
        };
    }

    private index(repo: ResolvedLinkedRepository): void {
        const keys = [
            repo.fullName,
            repo.repository,
            repo.name,
            repo.id,
            repo.fullName.split('/').pop() || '',
        ]
            .filter(Boolean)
            .map((k) => k.toLowerCase());
        for (const key of keys) {
            if (!this.byKey.has(key)) this.byKey.set(key, repo);
        }
    }

    private lookup(repoKey: string): ResolvedLinkedRepository | undefined {
        if (!repoKey) return undefined;
        const key = repoKey.trim().toLowerCase().replace(/\.git$/, '');
        return (
            this.byKey.get(key) ||
            this.byKey.get(key.split('/').pop() || key) ||
            undefined
        );
    }

    private async cloneRepo(repo: ResolvedLinkedRepository) {
        try {
            const cloneParams = await this.deps.getCloneParams(repo);
            if (!cloneParams?.url) {
                repo.status = 'failed';
                repo.reason = 'Could not resolve clone parameters';
                this.warnings.push(
                    `linkedRepositories: failed to resolve clone params for ${repo.fullName}`,
                );
                return {
                    ok: false as const,
                    error: `Could not resolve clone parameters for ${repo.fullName}`,
                };
            }

            const candidates =
                repo.refCandidates?.length > 0
                    ? repo.refCandidates
                    : [
                          {
                              fetchRef: repo.preferredRef,
                              displayRef: repo.preferredRef,
                              source: 'head-branch' as const,
                          },
                          {
                              fetchRef: repo.defaultBranch,
                              displayRef: repo.defaultBranch,
                              source: 'default' as const,
                          },
                          {
                              fetchRef: 'main',
                              displayRef: 'main',
                              source: 'fallback' as const,
                          },
                          {
                              fetchRef: 'master',
                              displayRef: 'master',
                              source: 'fallback' as const,
                          },
                      ];

            // Dedupe by fetchRef while preserving cascade order.
            const seenFetch = new Set<string>();
            const uniqueCandidates = candidates.filter((c) => {
                if (!c?.fetchRef || seenFetch.has(c.fetchRef)) return false;
                seenFetch.add(c.fetchRef);
                return true;
            });

            let lastError = '';
            for (const candidate of uniqueCandidates) {
                const result = await this.tryClone(
                    repo,
                    cloneParams,
                    candidate.fetchRef,
                );
                if (result.ok) {
                    repo.status = 'ready';
                    repo.resolvedRef = candidate.displayRef;
                    repo.resolvedFetchRef = candidate.fetchRef;
                    repo.resolvedSource = candidate.source;
                    repo.resolvedPrNumber = candidate.prNumber;
                    logger.log({
                        message: `[LINKED-REPO] cloned ${repo.fullName}@${candidate.displayRef} (fetch=${candidate.fetchRef}, source=${candidate.source}) → ${repo.rootPath}`,
                        context: 'LinkedRepoAccess',
                    });
                    return {
                        ok: true as const,
                        rootPath: repo.rootPath,
                        repository: repo.fullName,
                        ref: candidate.displayRef,
                    };
                }
                lastError = result.error;
            }

            repo.status = 'failed';
            repo.reason = lastError || 'clone failed';
            this.warnings.push(
                `linkedRepositories: failed to clone ${repo.fullName}: ${repo.reason}`,
            );
            logger.warn({
                message: `[LINKED-REPO] clone failed for ${repo.fullName}: ${repo.reason}`,
                context: 'LinkedRepoAccess',
            });
            return {
                ok: false as const,
                error: `Failed to clone ${repo.fullName}: ${repo.reason}`,
            };
        } catch (err) {
            const message =
                err instanceof Error ? err.message : String(err);
            repo.status = 'failed';
            repo.reason = message;
            this.warnings.push(
                `linkedRepositories: exception cloning ${repo.fullName}: ${message}`,
            );
            return {
                ok: false as const,
                error: `Failed to clone ${repo.fullName}: ${message}`,
            };
        }
    }

    private async tryClone(
        repo: ResolvedLinkedRepository,
        cloneParams: LinkedRepoCloneParams,
        ref: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        const { sandbox } = this.deps;
        const root = repo.rootPath;
        const safeRoot = shSingleQuote(root);
        const safeUrl = shSingleQuote(cloneParams.url);
        const safeRef = shSingleQuote(ref);
        const hasAuth = !!cloneParams.authToken;
        const authHeader = hasAuth
            ? buildAuthHeader(
                  cloneParams.platform,
                  cloneParams.authToken,
                  cloneParams.authUsername,
              )
            : '';

        // Clean any partial previous attempt, then shallow-clone with blob:none.
        // Token rides in GIT_AUTH_HEADER env (never the command string).
        const fetchCmd = hasAuth
            ? `git -c http.extraHeader="$GIT_AUTH_HEADER" fetch --depth=1 --filter=blob:none ${safeUrl} ${safeRef}:linked-head`
            : `git fetch --depth=1 --filter=blob:none ${safeUrl} ${safeRef}:linked-head`;

        // The auth header must ALSO ride on checkout: with --filter=blob:none
        // the checkout lazily fetches blobs from the promisor remote, and
        // without `-c http.extraHeader` that fetch runs unauthenticated and
        // dies with "could not read Username" (exit 128) on private repos.
        // Keeping it per-command (not `git config`) keeps the token out of
        // .git/config, which agent tools could otherwise read.
        const checkoutCmd = hasAuth
            ? `git -c http.extraHeader="$GIT_AUTH_HEADER" checkout linked-head`
            : `git checkout linked-head`;

        const cmd = [
            `rm -rf ${safeRoot}`,
            `mkdir -p ${safeRoot}`,
            `git init ${safeRoot}`,
            `cd ${safeRoot}`,
            fetchCmd,
            checkoutCmd,
            `git remote add origin ${safeUrl}`,
            `git remote set-url --push origin no-push-allowed`,
        ].join(' && ');

        try {
            const result = await sandbox.run(cmd, {
                timeoutMs: CLONE_TIMEOUT_MS,
                envs: hasAuth
                    ? { GIT_AUTH_HEADER: authHeader }
                    : undefined,
            });
            if (result.exitCode !== 0) {
                return {
                    ok: false,
                    error: (
                        result.stderr ||
                        result.stdout ||
                        `exit ${result.exitCode}`
                    ).slice(0, 300),
                };
            }
            return { ok: true };
        } catch (err) {
            // E2B's commands.run throws CommandExitError on non-zero exit;
            // its message is just "exit status N" — the actionable detail
            // (git's stderr) rides on the error object. Surface it.
            const e = err as {
                message?: string;
                stderr?: string;
                stdout?: string;
                result?: { stderr?: string; stdout?: string };
            };
            const detail =
                e?.stderr ||
                e?.result?.stderr ||
                e?.stdout ||
                e?.result?.stdout ||
                '';
            const message = [
                err instanceof Error ? err.message : String(err),
                detail,
            ]
                .filter(Boolean)
                .join(' — ');
            return {
                ok: false,
                error: message.slice(0, 300),
            };
        }
    }
}

/** Mirror of e2b-sandbox buildAuthHeader — kept local to avoid coupling. */
function buildAuthHeader(
    platform: PlatformType,
    token: string,
    username?: string,
): string {
    switch (platform) {
        case PlatformType.GITHUB:
            return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
        case PlatformType.BITBUCKET: {
            const gitUsername = token.startsWith('ATATT')
                ? 'x-bitbucket-api-token-auth'
                : username;
            if (!gitUsername) {
                throw new Error(
                    'Bitbucket authentication requires a username or an Atlassian API token.',
                );
            }
            return `Authorization: Basic ${Buffer.from(`${gitUsername}:${token}`).toString('base64')}`;
        }
        case PlatformType.GITLAB:
        case PlatformType.AZURE_REPOS:
            return `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
        default:
            return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    }
}

/**
 * Format the end-review transparency line (CodeRabbit-style).
 * Includes source when useful (e.g. "reviewed against open PR #123").
 * Returns empty string when nothing was consulted.
 */
export function formatLinkedReposSummaryLine(
    metadata: LinkedRepositoriesReviewMetadata | undefined,
): string {
    if (!metadata?.repositories?.length) return '';
    const used = metadata.repositories.filter((r) => r.status === 'ready');
    if (!used.length) return '';
    const parts = used.map((r) => {
        const ref = r.ref || 'unknown';
        // When the display ref already names the open PR, keep it compact.
        if (r.prNumber && !/PR\s*#/i.test(ref)) {
            return `\`${r.repository}@${ref}\` (open PR #${r.prNumber})`;
        }
        return `\`${r.repository}@${ref}\``;
    });
    return `\n\n**Additional context used:** ${parts.join(', ')}`;
}
