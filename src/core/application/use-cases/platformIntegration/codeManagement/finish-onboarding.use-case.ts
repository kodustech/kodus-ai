import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { FinishOnboardingDTO } from '@/core/infrastructure/http/dtos/finish-onboarding.dto';
import { Inject, Injectable } from '@nestjs/common';
import { CreatePRCodeReviewUseCase } from './create-prs-code-review.use-case';
import { GenerateCodeReviewParameterUseCase } from '../../parameters/generate-code-review-paremeter.use-case';
import { GenerateKodyRulesUseCase } from '../../kodyRules/generate-kody-rules.use-case';
import { REQUEST } from '@nestjs/core';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '../../kodyRules/find-rules-in-organization-by-filter.use-case';
import {
    IKodyRule,
    KodyRulesStatus,
} from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { ChangeStatusKodyRulesUseCase } from '../../kodyRules/change-status-kody-rules.use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { KodyLearningStatus } from '@/core/domain/parameters/types/configValue.type';

@Injectable()
export class FinishOnboardingUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly reviewPRUseCase: CreatePRCodeReviewUseCase,
        private readonly generateCodeReviewParameterUseCase: GenerateCodeReviewParameterUseCase,
        private readonly generateKodyRulesUseCase: GenerateKodyRulesUseCase,
        private readonly findKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        private readonly changeStatusKodyRulesUseCase: ChangeStatusKodyRulesUseCase,

        private readonly logger: PinoLoggerService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(params: FinishOnboardingDTO) {
        let platformConfig;

        try {
            if (!this.request.user.organization.uuid) {
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

            platformConfig = await this.parametersService.findByKey(
                ParametersKey.PLATFORM_CONFIGS,
                { organizationId, teamId },
            );

            if (!platformConfig || !platformConfig.configValue) {
                throw new Error('Platform config not found');
            }

            await this.parametersService.createOrUpdateConfig(
                ParametersKey.PLATFORM_CONFIGS,
                {
                    ...platformConfig.configValue,
                    finishOnboard: true,
                },
                { organizationId, teamId },
            );

            await this.generateCodeReviewParameterUseCase.execute({
                teamId,
                months: 3,
            });
            await this.generateKodyRulesUseCase.execute(
                { teamId, months: 3 },
                organizationId,
            );

            // enable all generated rules
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
