import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PinoLoggerService } from '../logger/pino.service';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationStatusFilter } from '@/core/domain/team/interfaces/team.interface';
import { STATUS } from '@/config/types/database/status.type';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { PullRequestsEntity } from '@/core/domain/pullRequests/entities/pullRequests.entity';
import { ImplementationStatus } from '@/core/domain/pullRequests/enums/implementationStatus.enum';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { IPullRequestsService, PULL_REQUESTS_SERVICE_TOKEN } from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { CodeManagementService } from '../platformIntegration/codeManagement.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { CodeReviewConfig, CodeReviewConfigWithRepositoryInfo, CodeSuggestion, Repository } from '@/config/types/general/codeReview.type';
import { PullRequestReviewComment, PullRequests, PullRequestsWithChangesRequested, PullRequestWithFiles } from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { IIntegrationService, INTEGRATION_SERVICE_TOKEN } from '@/core/domain/integrations/contracts/integration.service.contracts';
import moment from 'moment';

const API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED = process.env.API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED;

@Injectable()
export class CheckIfPRCanBeApprovedCronProvider {
    constructor(
        private readonly logger: PinoLoggerService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        private readonly codeManagementService: CodeManagementService,
    ) { }

    @Cron(API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED, {
        name: 'CHECK IF PR SHOULD BE APPROVED',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            this.logger.log({
                message: 'Check if PR can be approved cron started',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: {
                    timestamp: new Date().toISOString(),
                },
            });

            const teams = await this.teamService.findTeamsWithIntegrations({
                integrationCategories: [IntegrationCategory.CODE_MANAGEMENT],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                status: STATUS.ACTIVE,
            });

            if (!teams || teams.length === 0) {
                this.logger.log({
                    message: 'No teams found',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: {
                        timestamp: new Date().toISOString(),
                    },
                });

                return;
            }

            for (const team of teams) {
                const organizationId = team.organization?.uuid;
                const teamId = team.uuid;

                const organizationAndTeamData: OrganizationAndTeamData = {
                    organizationId,
                    teamId
                }

                const codeReviewParameter = await this.parametersService.findByKey(
                    ParametersKey.CODE_REVIEW_CONFIG,
                    organizationAndTeamData,
                );

                const codeReviewConfig = codeReviewParameter.configValue as {
                    global: CodeReviewConfig
                    repositories: CodeReviewConfigWithRepositoryInfo[]
                }

                if (!codeReviewParameter || !codeReviewConfig || !Array.isArray(codeReviewConfig.repositories) || codeReviewConfig.repositories.length < 1) {
                    this.logger.error({
                        message: 'Code review parameter configs not found',
                        context: CheckIfPRCanBeApprovedCronProvider.name,
                        metadata: {
                            teamId,
                            timestamp: new Date().toISOString(),
                        },
                    });

                    continue;
                }

                const openPullRequests = await this.pullRequestService.find({
                    status: PullRequestState.OPENED,
                    organizationId: organizationId
                })

                if (!openPullRequests || openPullRequests.length === 0) {
                    continue;
                }

                openPullRequests.map(async (pr) => {
                    const repository = pr.repository;

                    const codeReviewConfigFromRepo = codeReviewConfig.repositories.find((codeReviewConfigRepo) => codeReviewConfigRepo.id === repository.id)

                    if (!codeReviewConfig.global.pullRequestApprovalActive && !codeReviewConfigFromRepo?.pullRequestApprovalActive) {
                        return;
                    }

                    if (codeReviewConfigFromRepo?.pullRequestApprovalActive === false) {
                        return;
                    }


                    await this.shouldApprovePR({
                        organizationAndTeamData,
                        pr,
                    })
                });

                // let prsWithChangesRequested: PullRequestsWithChangesRequested[];


                // prsWithChangesRequested = await Promise.all(
                //     codeReviewConfig.repositories.map(async (repository) => {
                //         if (!codeReviewConfig.global.isRequestChangesActive && !repository?.isRequestChangesActive) {
                //             return;
                //         }


                //         const prsWithRequest = await this.codeManagementService.getPullRequestsWithChangesRequested({
                //             organizationAndTeamData,
                //             repository: repository,
                //         }, platformType);

                //         return prsWithRequest;
                //     })
                // ).then(results => results.flat())
                //     .catch((error) => {
                //         this.logger.error({
                //             message: 'Error fetching pull requests with changes requested for some repositories',
                //             context: CheckIfPRCanBeApprovedCronProvider.name, error
                //         }
                //         );
                //         return [];
                //     });

                // if (!prsWithChangesRequested || prsWithChangesRequested.length === 0) {
                //     continue;
                // }

                // const openPullRequestsWithRequestedChanges = openPullRequests.filter((pr) =>
                //     prsWithChangesRequested.map((prWithChangesRequested) => prWithChangesRequested.number).includes(pr.number)
                // )

                // if (!openPullRequestsWithRequestedChanges || openPullRequestsWithRequestedChanges.length === 0) {
                //     continue;
                // }

                // openPullRequestsWithRequestedChanges.map(async (pr) => {
                //     await this.shouldApprovePR({
                //         organizationAndTeamData,
                //         pr,
                //     })
                // });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error checking if PR can be approved generator cron',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                error,
                metadata: {
                    timestamp: new Date().toISOString(),
                },
            });
        }
    }

    private async shouldApprovePR({
        organizationAndTeamData,
        pr,
    }: {
        organizationAndTeamData: OrganizationAndTeamData,
        pr: PullRequestsEntity,
    }): Promise<boolean> {
        const repository = pr.repository;
        const prNumber = pr.number;
        const platformType = pr.provider as PlatformType;

        const codeManagementRequestData = {
            organizationAndTeamData,
            repository: {
                id: repository.id,
                name: repository.name,
            },
            prNumber: prNumber,
        }
        try {
            let isPlatformTypeGithub: boolean = platformType === PlatformType.GITHUB;

            let reviewComments: any[];
            if (isPlatformTypeGithub) {
                reviewComments = await this.codeManagementService.getPullRequestReviewThreads(codeManagementRequestData, PlatformType.GITHUB);
            }
            else {
                reviewComments = await this.codeManagementService.getPullRequestReviewComments(codeManagementRequestData, platformType);
            }

            // if (platformType === PlatformType.BITBUCKET) {
            //     await this.getValidUserReviews({ organizationAndTeamData, prNumber, repository, reviewComments });
            //     return true;
            // }

            if (!reviewComments || reviewComments.length < 1) {
                return false;
            }

            const isEveryReviewCommentResolved = reviewComments?.every((reviewComment) => reviewComment.isResolved);


            if (isEveryReviewCommentResolved) {
                await this.codeManagementService.approvePullRequest({
                    organizationAndTeamData,
                    prNumber,
                    repository: {
                        name: repository.name,
                        id: repository.id,
                    }
                }, platformType);
                return true;
            }

            // if (platformType === PlatformType.GITLAB) {
            //     return false;
            // }

            // let criticalSuggestions = this.getCriticalSuggestions(pr);

            // const foundComments: PullRequestReviewComment[] = isPlatformTypeGithub
            //     ? reviewComments.filter((comment) =>
            //         criticalSuggestions.map(c => c.comment.id).includes(Number(comment.fullDatabaseId))
            //     )
            //     : reviewComments.filter((comment) =>
            //         criticalSuggestions.map(c => c.comment.id).includes(comment.id)
            //     );

            // const resolvedComments = foundComments.filter((comment) => comment.isResolved == true)

            // if (resolvedComments.length < criticalSuggestions.length) {
            //     return false;
            // }

            // // Github has a different route where the reviews of different types are registered
            // // So we need to get all of them, filter so we get the ones that requested_changed and check if they're resolved.
            // if (isPlatformTypeGithub) {
            //     const validReviews = await this.codeManagementService.getListOfValidReviews(codeManagementRequestData, platformType);

            //     const unresolvedReviews = validReviews.filter((review) => review.isResolved === false);

            //     if (unresolvedReviews.length < 1) {
            //         await this.codeManagementService.approvePullRequest(codeManagementRequestData, platformType);
            //         return true;
            //     }
            //     return false;
            // }
            // else if (platformType === PlatformType.BITBUCKET) {
            //     /**
            //      * Each time someone requests a change, they appear as a reviewer on the PR (except kody, dunno why)
            //      * We can use the reviewers information to filter the comments arrays that were made by other users besides kody.
            //      * That should return to us a list of reviews specifically made by users. We can use this to check if the PR should be approved.
            //     */
            //     await this.getValidUserReviews({ organizationAndTeamData, prNumber, repository, reviewComments });

            // }
        }
        catch (error) {
            this.logger.error({
                message: 'Error in shouldApprovePR',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                error
            });

            return false;
        }
    }

    private async getValidUserReviews(params: {
        repository: Partial<Repository>,
        prNumber: number,
        organizationAndTeamData: OrganizationAndTeamData,
        reviewComments: any[]
    }): Promise<boolean> {
        const { organizationAndTeamData, prNumber, repository, reviewComments } = params;

        const pr: any = await this.codeManagementService.getPullRequestDetails({
            organizationAndTeamData, prNumber, repository: {
                id: repository.id,
                name: repository.name,
            }
        }, PlatformType.BITBUCKET);




        const kodyUser = reviewComments.find((reviewComment) => {
            return reviewComment.body && (reviewComment.body.includes('kody|code-review') || reviewComment.body.includes('![kody code-review]'));
        });

        const reviewers = kodyUser
            ? pr.participants.filter((participant) => participant.id !== kodyUser?.author.id)
            : pr.participants;


        const isEveryReviewCommentResolved = reviewComments?.every((reviewComment) => reviewComment.isResolved);

        if (isEveryReviewCommentResolved) {
            await this.codeManagementService.approvePullRequest({
                organizationAndTeamData,
                prNumber,
                repository: {
                    name: repository.name,
                    id: repository.id,
                }
            }, PlatformType.BITBUCKET);
            return true;
        }
        // const kodyReviewer = kodyUser
        //     ? pr.participants.find((participant) => participant.id === kodyUser?.author.id)
        //     : null;

        // if (kodyReviewer && kodyReviewer?.approved) {
        //     return true;
        // }

        // const anyReviewerApproved = reviewers.some((reviewer) => reviewer.approved);

        // if (anyReviewerApproved) {
        //     return true;
        // }

        // const validReviews = reviewComments.filter((reviewComment) => {
        //     return reviewers.some((reviewer) => reviewer.id === reviewComment.author.id);
        // });

        // const unresolvedReviews = validReviews.filter((review) => review.isResolved === false);

        // if (unresolvedReviews.length < 1) {
        //     await this.codeManagementService.approvePullRequest({
        //         organizationAndTeamData,
        //         prNumber,
        //         repository: {
        //             name: repository.name,
        //             id: repository.id,
        //         }
        //     }, PlatformType.BITBUCKET);
        //     return true;
        // }
        // return false;

    }

    // private getCriticalSuggestions(pr: PullRequestsEntity): CodeSuggestion[] {
    //     const implementedSuggestionsCommentIds: CodeSuggestion[] = [];

    //     pr.files?.forEach((file) => {
    //         if (file.suggestions.length > 0) {
    //             file.suggestions
    //                 ?.filter((suggestion) =>
    //                     suggestion.comment &&
    //                     suggestion.deliveryStatus === DeliveryStatus.SENT &&
    //                     suggestion.severity === SeverityLevel.CRITICAL
    //                 )
    //                 .forEach((filteredSuggestion) => {
    //                     implementedSuggestionsCommentIds.push(filteredSuggestion);
    //                 });
    //         }
    //     });

    //     return implementedSuggestionsCommentIds;
    // }




}
