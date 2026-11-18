import { createLogger } from '@libs/core/log/logger';
import type {
    CreateCheckRunParams,
    FindCheckRunParams,
    IChecksAdapter,
    UpdateCheckRunParams,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import {
    CheckConclusion,
    CheckStatus,
    KODY_CHECK_RUN_NAME,
    UnknownCheckConclusionError,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { Injectable } from '@nestjs/common';
import { repoCreateStatus } from '@llamaduck/forgejo-ts';
import { ForgejoService } from '../forgejo.service';

/**
 * Forgejo commit status states per the Forgejo API.
 * Unlike GitHub's Checks API, Forgejo uses the simpler commit status model:
 * POST a new status with the same `context` on the same SHA to "update".
 *
 * GitHub Checks API comparison:
 * - `name` → `context`: the code review keeps its historical label; any
 *   other check (the Kody Runtime) posts under its own name, so the two
 *   never replace each other's state on the same SHA.
 * - `output.title` / `output.summary` → `description`
 * - `status: in_progress/completed` → `state: pending/success/failure/warning`
 * - `conclusion: success/failure/neutral` → `state: success/failure/warning`
 */
const COMMIT_STATUS_CONTEXT = 'Kodus Code Review';

const CHECK_ID_PREFIX = 'sha:';

/** The commit status context a check name posts under. */
const contextOf = (name: string | undefined): string =>
    !name || name === KODY_CHECK_RUN_NAME ? COMMIT_STATUS_CONTEXT : name;

/**
 * The id handed back for a status: `sha:<sha>` for the code review (the
 * format stored before contexts were encoded), `sha:<sha>:<context>` for any
 * other check, so an update, which carries no name, posts under the same
 * context the create used.
 */
const checkIdOf = (sha: string, context: string): string =>
    context === COMMIT_STATUS_CONTEXT
        ? `${CHECK_ID_PREFIX}${sha}`
        : `${CHECK_ID_PREFIX}${sha}:${context}`;

// A completed status takes its state from the conclusion only: there is no
// default state for "completed", so a missing conclusion cannot read as green.
const statusStateMap: Record<
    Exclude<CheckStatus, CheckStatus.COMPLETED>,
    string
> = {
    [CheckStatus.QUEUED]: 'pending',
    [CheckStatus.IN_PROGRESS]: 'pending',
};

const conclusionStateMap: Record<CheckConclusion, string> = {
    [CheckConclusion.SUCCESS]: 'success',
    [CheckConclusion.FAILURE]: 'failure',
    [CheckConclusion.NEUTRAL]: 'warning',
    [CheckConclusion.SKIPPED]: 'warning',
    [CheckConclusion.ACTION_REQUIRED]: 'failure',
    [CheckConclusion.CANCELLED]: 'error',
    [CheckConclusion.TIMED_OUT]: 'error',
};

@Injectable()
export class ForgejoChecksService implements IChecksAdapter {
    private readonly logger = createLogger(ForgejoChecksService.name);

    constructor(private readonly forgejoService: ForgejoService) {}

    // Forgejo commit statuses are keyed by (sha, context): posting with the
    // same context replaces the previous state, so there is no run to reuse.
    async findCheckRun(params: FindCheckRunParams): Promise<string | null> {
        return null;
    }

    async createCheckRun(params: CreateCheckRunParams): Promise<string | null> {
        const {
            organizationAndTeamData,
            repository,
            headSha,
            output,
            status,
            name,
        } = params;
        const context = contextOf(name);

        try {
            const authDetail = await this.forgejoService.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetail) {
                this.logger.warn({
                    message:
                        'Skipping Forgejo commit status creation — no auth details',
                    context: ForgejoChecksService.name,
                    metadata: { repository: repository.name, headSha },
                });
                return null;
            }

            const client = this.forgejoService.createForgejoClient(authDetail);

            const state = this.resolveState(status);

            await repoCreateStatus({
                client,
                path: {
                    owner: repository.owner,
                    repo: repository.name,
                    sha: headSha,
                },
                body: {
                    state,
                    context,
                    description:
                        output?.title || output?.summary || 'Starting...',
                    target_url: this.buildTargetUrl(
                        authDetail.host,
                        repository.owner,
                        repository.name,
                        headSha,
                    ),
                },
            });

            this.logger.log({
                message: 'Created Forgejo commit status',
                context: ForgejoChecksService.name,
                metadata: {
                    repository: repository.name,
                    headSha,
                    state,
                    context,
                },
            });

            return checkIdOf(headSha, context);
        } catch (error) {
            this.logger.error({
                message: 'Failed to create Forgejo commit status',
                context: ForgejoChecksService.name,
                error,
                metadata: { repository: repository.name, headSha },
            });
            return null;
        }
    }

    async updateCheckRun(params: UpdateCheckRunParams): Promise<boolean> {
        const {
            organizationAndTeamData,
            repository,
            status,
            conclusion,
            output,
        } = params;

        // Validated before any call: an unknown conclusion is the caller's
        // error, not a failed update (ADR-052).
        const state = this.resolveState(status, conclusion);

        const target = this.resolveTarget(params);
        if (!target) {
            this.logger.warn({
                message:
                    'Cannot update Forgejo commit status — head SHA unavailable',
                context: ForgejoChecksService.name,
                metadata: {
                    checkRunId: params.checkRunId,
                    repository: repository.name,
                },
            });
            return false;
        }

        try {
            const authDetail = await this.forgejoService.getAuthDetails(
                organizationAndTeamData,
            );
            if (!authDetail) {
                this.logger.warn({
                    message:
                        'Skipping Forgejo commit status update — no auth details',
                    context: ForgejoChecksService.name,
                    metadata: { repository: repository.name },
                });
                return false;
            }

            const client = this.forgejoService.createForgejoClient(authDetail);

            const description = this.resolveDescription(
                status,
                conclusion,
                output,
            );

            await repoCreateStatus({
                client,
                path: {
                    owner: repository.owner,
                    repo: repository.name,
                    sha: target.sha,
                },
                body: {
                    state,
                    context: target.context,
                    description,
                    target_url: this.buildTargetUrl(
                        authDetail.host,
                        repository.owner,
                        repository.name,
                        target.sha,
                    ),
                },
            });

            this.logger.log({
                message: 'Updated Forgejo commit status',
                context: ForgejoChecksService.name,
                metadata: {
                    checkRunId: params.checkRunId,
                    repository: repository.name,
                    state,
                    description,
                },
            });

            return true;
        } catch (error) {
            this.logger.error({
                message: 'Failed to update Forgejo commit status',
                context: ForgejoChecksService.name,
                error,
                metadata: {
                    checkRunId: params.checkRunId,
                    repository: repository.name,
                },
            });
            return false;
        }
    }

    private resolveState(
        status?: CheckStatus,
        conclusion?: CheckConclusion,
    ): string {
        if (status === CheckStatus.COMPLETED || conclusion != null) {
            if (
                typeof conclusion !== 'string' ||
                !Object.prototype.hasOwnProperty.call(
                    conclusionStateMap,
                    conclusion,
                )
            ) {
                throw new UnknownCheckConclusionError(conclusion);
            }
            return conclusionStateMap[conclusion];
        }
        if (status) {
            return statusStateMap[status] ?? 'pending';
        }
        return 'pending';
    }

    /**
     * Resolve the human-readable description shown in the Forgejo CI section.
     * Mimics GitHub's check run output titles per stage.
     */
    private resolveDescription(
        status?: CheckStatus,
        conclusion?: CheckConclusion,
        output?: UpdateCheckRunParams['output'],
    ): string {
        if (output?.title) return output.title;

        if (status === CheckStatus.COMPLETED) {
            switch (conclusion) {
                case CheckConclusion.SUCCESS:
                    return 'Code Review Complete';
                case CheckConclusion.FAILURE:
                    return 'Code Review Failed';
                case CheckConclusion.NEUTRAL:
                    return 'Code Review Completed with Warnings';
                case CheckConclusion.SKIPPED:
                    return 'Code Review Skipped';
                case CheckConclusion.ACTION_REQUIRED:
                    return 'Code Review Needs Action';
                case CheckConclusion.CANCELLED:
                    return 'Code Review Cancelled';
                case CheckConclusion.TIMED_OUT:
                    return 'Code Review Timed Out';
            }
        }

        if (status === CheckStatus.IN_PROGRESS) {
            return output?.summary || 'Code Review In Progress';
        }

        return 'Code Review In Progress';
    }

    /**
     * Recover the head SHA and the context from the checkRunId this adapter
     * handed back (see checkIdOf). Forgejo commit status IDs are numeric and
     * not needed for updates: an update reposts by SHA and context. A name on
     * the update wins over the one encoded in the id.
     */
    private resolveTarget(
        params: UpdateCheckRunParams,
    ): { sha: string; context: string } | null {
        const { checkRunId } = params;
        if (
            typeof checkRunId !== 'string' ||
            !checkRunId.startsWith(CHECK_ID_PREFIX)
        ) {
            return null;
        }
        const rest = checkRunId.slice(CHECK_ID_PREFIX.length);
        const split = rest.indexOf(':');
        const sha = split === -1 ? rest : rest.slice(0, split);
        if (!sha) return null;
        const encoded = split === -1 ? undefined : rest.slice(split + 1);
        return { sha, context: contextOf(params.name ?? encoded) };
    }

    /**
     * Build the "Details" link URL for the Forgejo commit status.
     * Points to the commit page on the Forgejo instance, which is always
     * available and shows the status + any associated PRs.
     */
    private buildTargetUrl(
        host: string,
        owner: string,
        repo: string,
        sha: string,
    ): string {
        const baseUrl = host.replace(/\/$/, '');
        return `${baseUrl}/${owner}/${repo}/commit/${sha}`;
    }
}
