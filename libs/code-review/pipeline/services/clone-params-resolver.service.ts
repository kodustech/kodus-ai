import { Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { PlatformType } from '@libs/core/domain/enums';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

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
        if (!fullName || !name) return null;
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
            });
            return null;
        }

        const platform = gitContext.inferredPlatform || PlatformType.GITHUB;
        const branch = gitContext.branch || 'main';

        let authToken = '';
        let authUsername: string | undefined;
        let cloneUrl = gitContext.remote;

        // Trial users (anonymous) can pass their own PAT to clone private
        // repos. We use it directly and skip the integration lookup —
        // there's no integration row to find for anonymous traffic.
        if (gitContext.githubPat) {
            authToken = gitContext.githubPat;
        } else {
            try {
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
                        platform,
                    );
                authToken = cloneParams.auth?.token || '';
                authUsername = cloneParams.auth?.username;

                if (cloneParams.url) {
                    cloneUrl = cloneParams.url;
                }
            } catch (error) {
                this.logger.warn({
                    message: `Could not get auth token for CLI sandbox, trying without auth`,
                    context: CloneParamsResolverService.name,
                    error,
                });
            }
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
