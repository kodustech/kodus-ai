import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ChangeStatusKodyRulesDTO } from '@/core/infrastructure/http/dtos/change-status-kody-rules.dto';
import { CreateKodyRuleDto } from '@/core/infrastructure/http/dtos/create-kody-rule.dto';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';

export class ChangeStatusKodyRulesUseCase {
    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        private readonly logger: PinoLoggerService,

        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(body: ChangeStatusKodyRulesDTO) {
        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }

            const { ruleIds, status } = body;
            const organizationAndTeamData = {
                organizationId: this.request.user.organization.uuid,
            };

            const rules =
                await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                    this.request.user.organization.uuid,
                    {},
                );

            const updated = [];

            for (const ruleId of ruleIds) {
                const rule = rules.find((r) => r.uuid === ruleId);
                if (!rule) {
                    throw new Error(`Rule not found: ${ruleId}`);
                }

                const result = await this.kodyRulesService.createOrUpdate(
                    organizationAndTeamData,
                    {
                        ...rule,
                        status,
                    },
                );

                if (!result) {
                    throw new Error(
                        'Failed to change status pending Kody rule',
                    );
                }

                updated.push(result);
            }

            return updated;
        } catch (error) {
            this.logger.error({
                message: 'Could not change status pending Kody rules',
                context: ChangeStatusKodyRulesUseCase.name,
                serviceName: 'ChangeStatusPendingKodyRulesUseCase',
                error: error,
                metadata: {
                    body,
                },
            });
            throw error;
        }
    }
}
