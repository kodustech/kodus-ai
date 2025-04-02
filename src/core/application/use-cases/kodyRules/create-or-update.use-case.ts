import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { KODY_RULES_SERVICE_TOKEN } from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { IKodyRulesService } from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CreateKodyRuleDto } from '@/core/infrastructure/http/dtos/create-kody-rule.dto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class CreateOrUpdateKodyRulesUseCase {
    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        private readonly logger: PinoLoggerService,
    ) { }

    async execute(kodyRule: CreateKodyRuleDto, organizationId: string) {
        try {
            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
            };

            const result = await this.kodyRulesService.createOrUpdate(
                organizationAndTeamData,
                kodyRule,
            );

            if (!result) {
                throw new NotFoundException(
                    'Failed to create or update kody rule',
                );
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Could not create or update Kody rules',
                context: CreateOrUpdateKodyRulesUseCase.name,
                serviceName: 'CreateOrUpdateKodyRulesUseCase',
                error: error,
                metadata: {
                    kodyRule,
                    organizationAndTeamData: {
                        organizationId,
                    },
                },
            });
            throw error;
        }
    }
}
