import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    KODY_RULES_SERVICE_TOKEN,
    IKodyRulesService,
} from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class FindRuleInOrganizationByRuleIdKodyRulesUseCase {
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(ruleId: string) {
        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }

            const existing = await this.kodyRulesService.findByOrganizationId(
                this.request.user.organization.uuid,
            );

            if (!existing) {
                throw new NotFoundException(
                    'No Kody rules found for the given organization ID',
                );
            }

            const rule = existing.rules.find((rule) => rule.uuid === ruleId);

            if (!rule) {
                throw new NotFoundException('Rule not found');
            }

            return rule;
        } catch (error) {
            this.logger.error({
                message: 'Error finding Kody Rule in organization by rule ID',
                context: FindRuleInOrganizationByRuleIdKodyRulesUseCase.name,
                error: error,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                    ruleId,
                },
            });
            throw error;
        }
    }
}
