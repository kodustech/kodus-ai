import {
    KODY_RULES_SERVICE_TOKEN,
    IKodyRulesService,
} from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { Injectable, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class DeleteRuleInOrganizationByIdKodyRulesUseCase {
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
                return false;
            }

            if (!existing?.rules?.find((rule) => rule.uuid === ruleId)) {
                return false;
            }

            return await this.kodyRulesService.deleteRuleLogically(
                existing.uuid,
                ruleId,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error deleting Kody Rule in organization by ID',
                context: DeleteRuleInOrganizationByIdKodyRulesUseCase.name,
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
