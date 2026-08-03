import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject } from '@nestjs/common';

@Injectable()
export class DeleteByokConfigUseCase {
    private readonly logger = createLogger(DeleteByokConfigUseCase.name);

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(organizationId: string, configType: 'main' | 'fallback') {
        // Deletion used to be silent. Log it so a disconnected key is traceable
        // in observability_logs_ts: billing keeps its plan-derived `byok` flag
        // set, so a review that later falls back to managed credits and blocks
        // can be traced back to this event.
        this.logger.log({
            message: 'Deleting BYOK config',
            context: DeleteByokConfigUseCase.name,
            metadata: { organizationId, configType },
        });

        return await this.organizationParametersService.deleteByokConfig(
            organizationId,
            configType,
        );
    }
}
