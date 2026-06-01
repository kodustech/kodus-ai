import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import { stripCurlyBracesFromUUIDs } from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@libs/automation/domain/automationExecution/contracts/execute.automation.service.contracts';
import { PlatformType } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';

import { Inject, Injectable } from '@nestjs/common';
import { getMappedPlatform } from '@libs/common/utils/webhooks';
import { createLogger } from '@kodus/flow';
import { EnqueueCodeReviewJobInput } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

@Injectable()
export class RunCodeReviewAutomationUseCase implements IUseCase {
    private logger = createLogger(RunCodeReviewAutomationUseCase.name);

    constructor(
        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

        private readonly codeManagementService: CodeManagementService,
    ) {}

    async execute(params: EnqueueCodeReviewJobInput, signal?: AbortSignal) {
        try {
            const {
                codeManagementPayload: payload,
                event,
                platformType,
                teamAutomationId,
                organizationAndTeamData,
                correlationId,
                workflowJobId,
            } = params;

            if (!this.shouldRunAutomation(payload, platformType)) {
                return;
            }

            const mappedPlatform = getMappedPlatform(platformType);
            if (!mappedPlatform) {
                return;
            }

            const sanitizedPayload =
                platformType === PlatformType.BITBUCKET
                    ? stripCurlyBracesFromUUIDs(payload)
                    : payload;

            const action = mappedPlatform.mapAction({
                payload: sanitizedPayload,
                event: event,
            });

            if (!action) {
                return;
            }

            const repository = mappedPlatform.mapRepository({
                payload: sanitizedPayload,
            });

            if (!repository) {
                return;
            }

            let mappedUsers = mappedPlatform.mapUsers({
                payload: sanitizedPayload,
            });

            // GitLab webhooks expose `payload.user` as the actor (pusher /
            // commenter), not the MR author. Replace it so license validation
            // and downstream consumers see the actual author.
            if (platformType === PlatformType.GITLAB) {
                const author =
                    await this.codeManagementService.resolveMrAuthorFromWebhookPayload(
                        {
                            payload: sanitizedPayload,
                            organizationAndTeamData,
                        },
                        PlatformType.GITLAB,
                    );
                if (author) {
                    this.logger.log({
                        message:
                            'GitLab webhook actor replaced by resolved MR author',
                        context: RunCodeReviewAutomationUseCase.name,
                        metadata: {
                            organizationAndTeamData,
                            mrIid:
                                sanitizedPayload?.object_attributes?.iid ??
                                sanitizedPayload?.merge_request?.iid,
                            webhookActorId: sanitizedPayload?.user?.id,
                            resolvedAuthorId: author?.id,
                        },
                    });
                    mappedUsers = {
                        assignees: mappedUsers?.assignees,
                        reviewers: mappedUsers?.reviewers,
                        ...(mappedUsers ?? {}),
                        user: author,
                    };
                }
            }

            let pullRequestData = null;
            const pullRequest = mappedPlatform.mapPullRequest({
                payload: sanitizedPayload,
            });

            if (!pullRequest) {
                if (platformType === PlatformType.GITHUB) {
                    pullRequestData =
                        await this.codeManagementService.getPullRequest({
                            organizationAndTeamData,
                            repository: {
                                id: repository.id,
                                name: repository.name,
                            },
                            prNumber: sanitizedPayload?.issue?.number,
                        });
                }

                if (!pullRequestData) {
                    return;
                }

                // adjust it so it looks like the output from mapped platform
                const apiPullRequest = pullRequestData;
                pullRequestData = {
                    ...apiPullRequest,
                    repository: {
                        id: repository.id,
                        name: repository.name,
                    },
                    head: {
                        ref: apiPullRequest?.head?.ref,
                        sha: apiPullRequest?.head?.sha,
                        repo: {
                            fullName: apiPullRequest?.head?.repo?.fullName,
                        },
                    },
                    base: {
                        ref: apiPullRequest?.base?.ref,
                        sha: apiPullRequest?.base?.sha,
                        repo: {
                            fullName: apiPullRequest?.base?.repo?.fullName,
                            defaultBranch:
                                apiPullRequest?.base?.repo?.defaultBranch,
                        },
                    },
                    title: apiPullRequest?.title,
                    body: apiPullRequest?.body,
                    user: {
                        id: apiPullRequest?.user?.id,
                        login: apiPullRequest?.user?.login,
                        name: apiPullRequest?.user?.name,
                    },
                    isDraft:
                        apiPullRequest?.isDraft ??
                        apiPullRequest?.draft ??
                        false,
                };
            }

            pullRequestData = pullRequestData ?? pullRequest;

            if (
                platformType === PlatformType.GITLAB &&
                mappedUsers?.user &&
                pullRequestData
            ) {
                pullRequestData = {
                    ...pullRequestData,
                    user: mappedUsers.user,
                };
            }

            let repositoryData = repository;
            // Only github provides the language in the webhook, so for the others try to get it
            if (
                !repositoryData.language &&
                platformType !== PlatformType.GITHUB
            ) {
                repositoryData = {
                    ...repository,
                    language:
                        await this.codeManagementService.getLanguageRepository({
                            organizationAndTeamData,
                            repository: {
                                id: repository.id,
                                name: repository.name,
                            },
                        }),
                };
            }

            this.logger.log({
                message: `RunCodeReviewAutomationUseCase PR#${pullRequestData?.number}`,
                context: RunCodeReviewAutomationUseCase.name,
                metadata: {
                    organizationAndTeamData,
                    repository: repositoryData,
                    pullRequest: pullRequestData,
                    branch: pullRequestData?.head?.ref,
                    codeManagementEvent: event,
                    platformType: platformType,
                    origin: sanitizedPayload?.origin,
                },
            });

            const userGitId =
                // in azure repos, the user id is the descriptor
                mappedUsers?.user?.descriptor?.toString() ||
                mappedUsers?.user?.id?.toString() ||
                mappedUsers?.user?.uuid?.toString();

            const strategyParams = {
                organizationAndTeamData,
                teamAutomationId: teamAutomationId,
                repository: repositoryData,
                pullRequest: pullRequestData,
                branch: pullRequestData?.head?.ref,
                codeManagementEvent: event,
                platformType: platformType,
                origin: sanitizedPayload?.origin,
                action,
                //TODO: prcisa do byokauu
                //byokConfig,
                triggerCommentId: sanitizedPayload?.triggerCommentId,
                userGitId,
                workflowJobId,
                correlationId,
                // Job-level AbortSignal — strategies that reach the LLM call
                // chain (agent-loop, plan-pass, etc.) listen to this and abort
                // when the 1h45min job timeout fires.
                signal,
            };

            const result = await this.executeAutomation.executeStrategy(
                AutomationType.AUTOMATION_CODE_REVIEW,
                strategyParams,
            );

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error executing code review automation',
                context: RunCodeReviewAutomationUseCase.name,
                error: error,
                metadata: {
                    correlationId: params.correlationId,
                    ...params.organizationAndTeamData,
                },
            });
        }
    }

    private shouldRunAutomation(payload: any, platformType: PlatformType) {
        const allowedActions = [
            'opened',
            'synchronize',
            'synchronized', // Forgejo uses 'synchronized' instead of 'synchronize'
            'ready_for_review',
            'open',
            'update',
            'git.pullrequest.updated',
            'git.pullrequest.created',
        ];
        const currentAction =
            payload?.action ||
            payload?.object_attributes?.action ||
            payload?.eventType;

        const isMerged =
            payload?.object_attributes?.state === 'merged' ||
            payload?.resource?.pullRequest?.status === 'completed' ||
            payload?.resource?.status === 'completed' ||
            false;

        const isCommand =
            typeof payload?.origin === 'string' &&
            payload.origin.startsWith('command');

        // bitbucket has already been handled in the webhook validation
        if (
            !isCommand &&
            platformType !== PlatformType.BITBUCKET &&
            (!allowedActions.includes(currentAction) || isMerged)
        ) {
            this.logger.log({
                message: 'Automation skipped',
                context: RunCodeReviewAutomationUseCase.name,
                metadata: { currentAction, isMerged, platformType },
            });
            return false;
        }

        return true;
    }
}
