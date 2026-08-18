import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    describeLLMConfigStatus,
    type LLMConfigStatus,
} from '@libs/llm/llm-config-status';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { Inject, Injectable } from '@nestjs/common';

// The LLM-config status shape lives in @libs/llm (llm-config-status.ts) — the
// whole projection is LLM logic. Re-export the types here for back-compat, since
// callers (the FE fetch layer) import them from this use-case's barrel.
export type {
    LLMConfigSource,
    LLMModelStatus,
    LLMConfigStatus,
} from '@libs/llm/llm-config-status';

/**
 * Thin DB shell: fetch the org's stored BYOK_CONFIG blob and hand it to the
 * pure `describeLLMConfigStatus` projection in @libs/llm. No LLM logic here —
 * only the persistence read + best-effort degrade.
 */
@Injectable()
export class GetLLMConfigStatusUseCase implements IUseCase {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<LLMConfigStatus> {
        const parameter = await this.organizationParametersService
            .findByKey(
                OrganizationParametersKey.BYOK_CONFIG,
                organizationAndTeamData,
            )
            .catch(() => null);

        return describeLLMConfigStatus(parameter?.configValue);
    }
}
