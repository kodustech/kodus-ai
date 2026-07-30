import { Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import { PlatformType } from '@libs/core/domain/enums';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

/**
 * Extract the host of a git remote, accepting both URL forms we deal with
 * (`https://host/path` and the scp-like `git@host:path`).
 */
export function extractRemoteHost(url: string): string | undefined {
    const value = url.trim();
    if (!value) {
        return undefined;
    }

    // scp-like (`git@host:path`) is not a parseable URL — match it first.
    const scpLike = value.match(/^[^@\s/]+@([^:/]+):/);
    if (scpLike) {
        return scpLike[1].toLowerCase();
    }

    try {
        return new URL(value).hostname.toLowerCase() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Parse a git remote URL (HTTPS or SSH) into fullName/name parts.
 *
 * Accepts any number of path segments so hosts with nested namespaces work
 * (e.g. GitLab subgroups `group/subgroup/repo`, Bitbucket workspaces). The
 * final segment is the repo name; everything between the host and the repo
 * name is the path-prefixed fullName.
 *
 * Supports:
 *  - https://github.com/owner/repo(.git)?/?
 *  - https://gitlab.com/group/subgroup/repo(.git)?/?
 *  - git@github.com:owner/repo(.git)?
 *  - git@gitlab.com:group/subgroup/repo(.git)?
 */
export function parseGitRemoteUrl(
    url: string,
): { fullName: string; name: string } | null {
    const extract = (path: string) => {
        const fullName = path.replace(/\.git$/, '').replace(/\/+$/, '');
        const name = fullName.split('/').pop() || '';

        if (!fullName || !name) {
            return null;
        }

        return { fullName, name };
    };

    // HTTPS format: https://host/<any/number/of/segments>(.git)?/?
    const httpsMatch = url.match(/^https?:\/\/[^/]+\/(.+?)\/?$/);
    if (httpsMatch) {
        const parsed = extract(httpsMatch[1]);
        if (parsed) return parsed;
    }

    // SSH format: git@host:<any/number/of/segments>(.git)?
    const sshMatch = url.match(/^[^@\s]+@[^:]+:(.+?)\/?$/);
    if (sshMatch) {
        const parsed = extract(sshMatch[1]);
        if (parsed) return parsed;
    }

    return null;
}

@Injectable()
export class CloneParamsResolverService {
    private readonly logger = createLogger(CloneParamsResolverService.name);

    constructor(
        private readonly codeManagementService: CodeManagementService,
    ) {}

    /**
     * Resolve clone parameters based on context origin.
     * - PR mode: uses codeManagementService.getCloneParams() as before
     * - CLI mode: parses git remote URL and tries to get auth from platform integration
     */
    async resolve(
        context: CodeReviewPipelineContext,
        cliContext?: CliReviewPipelineContext,
    ): Promise<{
        url: string;
        authToken: string;
        authUsername?: string;
        branch: string;
        baseBranch?: string;
        prNumber?: number;
        platform: PlatformType;
        /**
         * CLI-only: SHA the sandbox should checkout instead of fetching the
         * branch ref. Set when the user has a local merge-base with the
         * upstream default branch — guarantees the SHA exists on the remote
         * even if the user's branch hasn't been pushed yet.
         */
        checkoutSha?: string;
    } | null> {
        if (context.origin !== 'cli') {
            const cloneParams = await this.codeManagementService.getCloneParams(
                {
                    repository: context.repository,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
                context.platformType,
            );

            return {
                url: cloneParams.url,
                authToken: cloneParams.auth?.token || '',
                authUsername: cloneParams.auth?.username,
                branch: context.branch,
                baseBranch:
                    context.pullRequest?.base?.ref ||
                    context.repository?.defaultBranch ||
                    'main',
                prNumber: context.pullRequest.number,
                platform: context.platformType,
            };
        }

        // CLI mode
        const gitContext = cliContext?.gitContext;
        if (!gitContext?.remote) {
            return null;
        }

        const parsed = parseGitRemoteUrl(gitContext.remote);
        if (!parsed) {
            this.logger.warn({
                message: `Could not parse git remote URL: ${gitContext.remote}`,
                context: CloneParamsResolverService.name,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    remoteHost: extractRemoteHost(gitContext.remote),
                },
            });
            return null;
        }

        // The CLI can only infer a platform from well-known SaaS hostnames
        // (github.com, gitlab.com, ...), so a self-managed host — GitLab
        // CE/EE, Bitbucket Server, Gitea/Forgejo, GHES — arrives here
        // undefined. Do NOT guess GitHub: getCloneParams would then hand back
        // a github.com URL built from `fullName` and the sandbox would clone
        // from the wrong server entirely (#1541). Left undefined,
        // getCloneParams resolves the organization's connected integration.
        const inferredPlatform = gitContext.inferredPlatform;
        const branch = gitContext.branch || 'main';

        let platform = inferredPlatform;
        let authToken = '';
        let authUsername: string | undefined;
        let cloneUrl = gitContext.remote;

        // Trial users (anonymous) can pass their own PAT to clone private
        // repos. We use it directly and skip the integration lookup —
        // there's no integration row to find for anonymous traffic.
        if (gitContext.githubPat) {
            authToken = gitContext.githubPat;
            platform = platform ?? PlatformType.GITHUB;
        } else {
            try {
                // Passing an undefined platform is deliberate: getCloneParams
                // then resolves the team's connected integration itself, which
                // is the only thing that knows a self-managed host.
                const cloneParams =
                    await this.codeManagementService.getCloneParams(
                        {
                            repository: {
                                id: '0',
                                defaultBranch: branch,
                                fullName: parsed.fullName,
                                name: parsed.name,
                            },
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                        },
                        inferredPlatform,
                    );

                if (cloneParams) {
                    authToken = cloneParams.auth?.token || '';
                    authUsername = cloneParams.auth?.username;
                    platform = cloneParams.provider ?? platform;

                    if (cloneParams.url) {
                        cloneUrl = cloneParams.url;
                    }
                }
            } catch (error) {
                this.logger.warn({
                    message: `Could not get auth token for CLI sandbox, trying without auth`,
                    context: CloneParamsResolverService.name,
                    error,
                    metadata: {
                        organizationAndTeamData: context.organizationAndTeamData,
                        remoteHost: extractRemoteHost(gitContext.remote),
                        inferredPlatform,
                    },
                });
            }
        }

        // No integration and nothing inferable: we know neither the platform
        // nor a credential, and platform drives the git auth header shape.
        // Skip the sandbox instead of guessing — the review still runs, just
        // without the sandbox-dependent stages.
        if (!platform) {
            this.logger.warn({
                message: `Could not resolve the platform for the CLI sandbox remote; skipping sandbox`,
                context: CloneParamsResolverService.name,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    remoteHost: extractRemoteHost(gitContext.remote),
                },
            });
            return null;
        }

        // Ensure HTTPS (E2B requires HTTPS for token auth)
        if (cloneUrl.startsWith('git@')) {
            const sshMatch = cloneUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);
            if (sshMatch) {
                cloneUrl = `https://${sshMatch[1]}/${sshMatch[2]}`;
            } else {
                this.logger.warn({
                    message: `Could not parse SSH-like git remote URL: ${cloneUrl}`,
                    context: CloneParamsResolverService.name,
                    metadata: {
                        organizationAndTeamData: context.organizationAndTeamData,
                        remoteHost: extractRemoteHost(cloneUrl),
                        platform,
                    },
                });
                return null;
            }
        }

        return {
            url: cloneUrl,
            authToken,
            authUsername,
            branch,
            prNumber: undefined,
            platform,
            checkoutSha: gitContext.mergeBaseSha,
        };
    }
}
