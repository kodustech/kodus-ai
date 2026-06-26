import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { FinishOnboardingDTO } from '@libs/platform/dtos/finish-onboarding.dto';

import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';

import { CreatePRCodeReviewUseCase } from './create-prs-code-review.use-case';
import { SyncSelectedRepositoriesKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/sync-selected-repositories.use-case';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

@Injectable()
export class FinishOnboardingUseCase {
    private readonly logger = createLogger(FinishOnboardingUseCase.name);
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        private readonly reviewPRUseCase: CreatePRCodeReviewUseCase,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                organization: { uuid: string };
                uuid?: string;
                email?: string;
            };
        },
        private readonly syncSelectedReposKodyRulesUseCase: SyncSelectedRepositoriesKodyRulesUseCase,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly telemetry: TelemetryService,
    ) {}

    async execute(params: FinishOnboardingDTO) {
        let platformConfig;

        try {
            if (!this.request?.user?.organization?.uuid) {
                throw new Error('Organization ID not found');
            }

            const {
                teamId,
                reviewPR,
                pullNumber,
                repositoryName,
                repositoryId,
            } = params;

            const organizationId = this.request.user.organization.uuid;

            // [TIMING:onboarding] Provider-comparative instrumentation —
            // bitbucket finish-onboarding was observed far slower than
            // github/gitlab; the per-step breakdown isolates the slow path
            // (now `syncSelectedReposKodyRulesUseCase` provider tree reads).
            // Logs land in the api container so a single tail can isolate it.
            const __onboardingT0 = Date.now();
            const __mark = (
                label: string,
                start: number,
                extra: Record<string, unknown> = {},
            ) => {
                // console.log directly so the line survives whatever
                // structured-logger level filtering the framework
                // applies in production builds (which silently dropped
                // the first attempt that used this.logger.log).
                console.log(
                    `[TIMING:onboarding] ${label} took ${Date.now() - start}ms`,
                    JSON.stringify({
                        teamId,
                        step: label,
                        durationMs: Date.now() - start,
                        ...extra,
                    }),
                );
            };

            let __t = Date.now();
            platformConfig = await this.parametersService.findByKey(
                ParametersKey.PLATFORM_CONFIGS,
                { organizationId, teamId },
            );
            __mark('findByKey:PLATFORM_CONFIGS', __t);

            if (!platformConfig || !platformConfig.configValue) {
                throw new Error('Platform config not found');
            }

            __t = Date.now();
            await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.PLATFORM_CONFIGS,
                {
                    ...platformConfig.configValue,
                    finishOnboard: true,
                },
                { organizationId, teamId },
            );
            __mark('createOrUpdate:PLATFORM_CONFIGS', __t);

            // Onboarding only imports rules from repo files (fast, no LLM).
            // Generating rules from past reviews is a separate async action
            // (POST /kody-rules/generate-kody-rules + the KodyLearning cron),
            // so onboarding no longer blocks on or force-activates generated
            // rules — they go through the unified approval policy instead.

            // Trigger immediate Kody Rules sync from repo files for all selected repositories
            __t = Date.now();
            await this.syncSelectedReposKodyRulesUseCase.execute({ teamId });
            __mark('syncSelectedReposKodyRules', __t);

            __mark('TOTAL', __onboardingT0);

            if (reviewPR) {
                if (!pullNumber || !repositoryName || !repositoryId) {
                    throw new Error('Invalid PR data');
                }

                await this.reviewPRUseCase.execute({
                    teamId,
                    payload: {
                        id: repositoryId,
                        repository: repositoryName,
                        pull_number: pullNumber,
                    },
                });
            }

            const userId = this.request?.user?.uuid;
            const userEmail = this.request?.user?.email;
            if (userId) {
                // Best-effort hydration for human-readable names in telemetry
                // (Discord/Slack messages). If the lookup fails, telemetry
                // still fires with just the IDs — `safeCall` covers it.
                let teamName: string | undefined;
                let organizationName: string | undefined;
                try {
                    const team = await this.teamService.findById(teamId);
                    teamName = team?.name;
                    organizationName = team?.organization?.name;
                } catch (error) {
                    this.logger.warn({
                        message:
                            'Failed to resolve team/org names for onboarding telemetry; falling back to IDs only',
                        context: FinishOnboardingUseCase.name,
                        metadata: {
                            teamId,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                    });
                }

                void this.telemetry.onboardingCompleted({
                    userId,
                    email: userEmail,
                    organizationId,
                    organizationName,
                    teamId,
                    teamName,
                    reviewedPR: !!reviewPR,
                });

                if (reviewPR) {
                    void this.telemetry.onboardingReviewTriggered({
                        userId,
                        email: userEmail,
                        teamId,
                        organizationId,
                        repositoryId,
                    });
                } else {
                    void this.telemetry.onboardingReviewSkipped({
                        userId,
                        email: userEmail,
                        teamId,
                        organizationId,
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Error on OnboardingReviewPRUseCase',
                context: FinishOnboardingUseCase.name,
                error,
                metadata: params,
            });

            throw error;
        }
    }

}
