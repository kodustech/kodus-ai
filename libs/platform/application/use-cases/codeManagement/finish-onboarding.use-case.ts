import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { FinishOnboardingDTO } from '@libs/platform/dtos/finish-onboarding.dto';

import { retryWithBackoff } from '@libs/common/utils/polling';
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
import { GenerateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/generate-kody-rules.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-rules-in-organization-by-filter.use-case';
import { ChangeStatusKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/change-status-kody-rules.use-case';
import { SyncSelectedRepositoriesKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/sync-selected-repositories.use-case';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
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
        private readonly generateKodyRulesUseCase: GenerateKodyRulesUseCase,
        private readonly findKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        private readonly changeStatusKodyRulesUseCase: ChangeStatusKodyRulesUseCase,
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
            // bitbucket finish-onboarding was observed at 70-112s on the
            // 2026-05-22 self-hosted matrix vs. 1-4s for github/gitlab.
            // We need a per-step breakdown to confirm whether the slow
            // path is `generateKodyRulesUseCase` (LLM + provider PR
            // fetch) or `syncSelectedReposKodyRulesUseCase` (provider
            // tree read) or something else entirely. Logs land in the
            // api container so a single tail can isolate the answer.
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

            // Rule generation makes dozens of provider API calls and can
            // take tens of seconds, and on Bitbucket Cloud the per-endpoint
            // burst limits (x-envoy-ratelimited=true) blow past even
            // sequential calls with exponential-backoff 429 retry inside a
            // single HTTP request. The previous synchronous block here
            // (await generateKodyRulesUseCase + findKodyRules + activate)
            // surfaced as `finishOnboarding HTTP 500` on the 2026-05-23
            // self-hosted matrix because GenerateKodyRulesUseCase exhausted
            // its retries on Atlassian Edge throttling (and measured
            // 70–112s on Bitbucket vs 1–4s for GitHub/GitLab on the
            // 2026-05-22 run). The same work runs inside
            // `generateKodyRulesInBackground` below, which already does
            // generate → find → activate with retry-with-backoff wrapping
            // the whole pipeline and owns the kodyLearningStatus lifecycle
            // (GENERATING_RULES → ENABLED) so the frontend poll resolves
            // regardless. Detaching it lets finishOnboarding return
            // immediately instead of holding the HTTP request open for the
            // duration of rule generation.
            setImmediate(() => {
                void this.generateKodyRulesInBackground(organizationId, teamId);
            });

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

    /**
     * Generate Kody rules from PR history and activate them.
     *
     * Runs detached from the HTTP request (fired via `setImmediate` in
     * `execute`), so it must not read `this.request` — org/team come in as
     * arguments. Best-effort: it retries with backoff and, on final
     * failure, logs and returns. `GenerateKodyRulesUseCase` manages the
     * `kodyLearningStatus` lifecycle (GENERATING_RULES → ENABLED) itself,
     * including on error, so the frontend poll always resolves.
     */
    private async generateKodyRulesInBackground(
        organizationId: string,
        teamId: string,
    ): Promise<void> {
        try {
            await retryWithBackoff(
                () =>
                    this.generateKodyRulesUseCase.execute(
                        { teamId, months: 3 },
                        organizationId,
                    ),
                {
                    maxAttempts: 3,
                    onRetry: ({ error, attempt, delayMs }) => {
                        this.logger.warn({
                            message: `Kody rules generation failed (attempt ${attempt}); retrying in ${delayMs}ms`,
                            context: FinishOnboardingUseCase.name,
                            error:
                                error instanceof Error
                                    ? error
                                    : new Error(String(error)),
                            metadata: { organizationId, teamId },
                        });
                    },
                },
            );

            // Enable all freshly generated rules.
            const rules = await this.findKodyRulesUseCase.execute(
                organizationId,
                {},
            );

            if (rules && rules.length > 0) {
                const ruleIds = rules.map((rule) => rule.uuid);
                await this.changeStatusKodyRulesUseCase.execute({
                    ruleIds,
                    status: KodyRulesStatus.ACTIVE,
                });
            }
        } catch (error) {
            this.logger.error({
                message:
                    'Kody rules generation failed after retries; onboarding already completed',
                context: FinishOnboardingUseCase.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { organizationId, teamId },
            });
        }
    }
}
