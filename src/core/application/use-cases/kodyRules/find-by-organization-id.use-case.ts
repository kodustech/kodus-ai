import {
    KODY_RULES_SERVICE_TOKEN,
    IKodyRulesService,
} from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class FindByOrganizationIdKodyRulesUseCase {
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute() {
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

            return existing;
        } catch (error) {
            this.logger.error({
                message: 'Error finding Kody Rules by organization ID',
                context: FindByOrganizationIdKodyRulesUseCase.name,
                error: error,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                },
            });
            throw error;
        }
    }
}
