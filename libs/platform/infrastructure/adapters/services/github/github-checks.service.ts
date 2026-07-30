import { createLogger } from '@libs/core/log/logger';
import {
    CheckConclusion,
    CheckStatus,
    CreateCheckRunParams,
    FindCheckRunParams,
    IChecksAdapter,
    UpdateCheckRunParams,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { GithubService } from './github.service';

enum GithubCheckStatus {
    QUEUED = 'queued',
    IN_PROGRESS = 'in_progress',
    COMPLETED = 'completed',
}

enum GithubCheckConclusion {
    ACTION_REQUIRED = 'action_required',
    CANCELLED = 'cancelled',
    FAILURE = 'failure',
    NEUTRAL = 'neutral',
    SUCCESS = 'success',
    SKIPPED = 'skipped',
    STALE = 'stale',
    TIMED_OUT = 'timed_out',
}

const checkStatusMap = {
    [CheckStatus.IN_PROGRESS]: GithubCheckStatus.IN_PROGRESS,
    [CheckStatus.COMPLETED]: GithubCheckStatus.COMPLETED,
} as const;

const checkConclusionMap = {
    [CheckConclusion.FAILURE]: GithubCheckConclusion.FAILURE,
    [CheckConclusion.SUCCESS]: GithubCheckConclusion.SUCCESS,
    [CheckConclusion.NEUTRAL]: GithubCheckConclusion.NEUTRAL,
    [CheckConclusion.SKIPPED]: GithubCheckConclusion.SKIPPED,
} as const;
@Injectable()
export class GithubChecksService implements IChecksAdapter {
    private readonly logger = createLogger(GithubChecksService.name);

    constructor(private readonly gitHubService: GithubService) {}

    async findCheckRun(params: FindCheckRunParams): Promise<number | null> {
        const { organizationAndTeamData, repository, headSha, name } = params;

        try {
            const authDetails = await this.gitHubService.getGithubAuthDetails(
                organizationAndTeamData,
            );

            if (authDetails.authMode === AuthMode.TOKEN) {
                return null;
            }

            const octokit = await this.gitHubService.getAuthenticatedOctokit(
                organizationAndTeamData,
            );

            const response = await octokit.checks.listForRef({
                owner: repository.owner,
                repo: repository.name,
                ref: headSha,
                check_name: name,
                filter: 'latest',
                per_page: 1,
            });

            const checkRun = response.data.check_runs?.[0];

            if (!checkRun) {
                return null;
            }

            // A completed check run cannot be reopened: PATCHing status back
            // to in_progress returns 200 but GitHub silently keeps
            // status=completed/conclusion. Only queued/in_progress runs are
            // reusable — for completed ones the caller creates a fresh run
            // with the same name, which the PR UI surfaces as the latest.
            if (checkRun.status === GithubCheckStatus.COMPLETED) {
                return null;
            }

            return checkRun.id;
        } catch (error) {
            this.logger.warn({
                message: `Failed to look up existing GitHub Check Run`,
                context: GithubChecksService.name,
                error,
                metadata: {
                    repository: repository.name,
                    headSha,
                    name,
                },
            });
            return null;
        }
    }

    async createCheckRun(params: CreateCheckRunParams): Promise<number | null> {
        const {
            organizationAndTeamData,
            repository,
            headSha,
            name,
            output,
            status,
        } = params;

        try {
            const authDetails = await this.gitHubService.getGithubAuthDetails(
                organizationAndTeamData,
            );

            if (authDetails.authMode === AuthMode.TOKEN) {
                this.logger.log({
                    message: `Skipping GitHub Check Run creation - not supported with PAT authentication`,
                    context: GithubChecksService.name,
                    metadata: {
                        repository: repository.name,
                        headSha,
                        authMode: authDetails.authMode,
                    },
                });
                return null;
            }

            const octokit = await this.gitHubService.getAuthenticatedOctokit(
                organizationAndTeamData,
            );

            const response = await octokit.checks.create({
                owner: repository.owner,
                repo: repository.name,
                name,
                head_sha: headSha,
                status: checkStatusMap[status] || GithubCheckStatus.IN_PROGRESS,
                started_at: new Date().toISOString(),
                output,
            });

            this.logger.log({
                message: `Created GitHub Check Run`,
                context: GithubChecksService.name,
                metadata: {
                    checkRunId: response.data.id,
                    repository: repository.name,
                    headSha,
                },
            });

            return response.data.id;
        } catch (error) {
            this.logger.error({
                message: `Failed to create GitHub Check Run`,
                context: GithubChecksService.name,
                error,
                metadata: {
                    repository: repository.name,
                    headSha,
                },
            });
            return null;
        }
    }

    async updateCheckRun(params: UpdateCheckRunParams): Promise<boolean> {
        const {
            organizationAndTeamData,
            repository,
            checkRunId,
            status,
            name,
            output,
            conclusion,
        } = params;

        try {
            const authDetails = await this.gitHubService.getGithubAuthDetails(
                organizationAndTeamData,
            );

            if (authDetails.authMode === AuthMode.TOKEN) {
                this.logger.log({
                    message: `Skipping GitHub Check Run update - not supported with PAT authentication`,
                    context: GithubChecksService.name,
                    metadata: {
                        repository: repository.name,
                        checkRunId,
                        authMode: authDetails.authMode,
                    },
                });
                return false;
            }

            const octokit = await this.gitHubService.getAuthenticatedOctokit(
                organizationAndTeamData,
            );

            const updateData: Parameters<Octokit['checks']['update']>[0] = {
                owner: repository.owner,
                repo: repository.name,
                check_run_id:
                    typeof checkRunId === 'string'
                        ? parseInt(checkRunId, 10)
                        : checkRunId,
            };

            if (status) {
                updateData.status =
                    checkStatusMap[status] || GithubCheckStatus.IN_PROGRESS;
            }
            if (status === CheckStatus.COMPLETED || conclusion) {
                updateData.conclusion =
                    checkConclusionMap[conclusion] ||
                    GithubCheckConclusion.SUCCESS;
            }

            if (output) {
                updateData.output = output;
            }

            if (name) {
                updateData.name = name;
            }

            await octokit.checks.update(updateData);

            this.logger.log({
                message: `Updated GitHub Check Run`,
                context: GithubChecksService.name,
                metadata: {
                    checkRunId,
                    repository: repository.name,
                    status,
                    organizationAndTeamData,
                },
            });

            return true;
        } catch (error) {
            this.logger.error({
                message: `Failed to update GitHub Check Run`,
                context: GithubChecksService.name,
                error,
                metadata: {
                    checkRunId,
                    repository: repository.name,
                    organizationAndTeamData,
                },
            });
            return false;
        }
    }
}
