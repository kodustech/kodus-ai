import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { KodyRuleFilters } from '@/config/types/kodyRules.type';
import {
    KODY_RULES_SERVICE_TOKEN,
    IKodyRulesService,
} from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class FindLibraryKodyRulesUseCase {
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        private readonly logger: PinoLoggerService,
    ) { }

    async execute(kodyRuleFilters?: KodyRuleFilters) {
        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }

            const libraryKodyRules =
                await this.kodyRulesService.getLibraryKodyRules(kodyRuleFilters);

            return libraryKodyRules;
        } catch (error) {
            this.logger.error({
                message: 'Error finding Kody Rule in organization by rule ID',
                context: FindLibraryKodyRulesUseCase.name,
                error: error,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                },
            });
            throw error;
        }
    }
}
