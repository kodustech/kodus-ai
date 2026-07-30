import { Inject, Injectable } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import {
    collectByokModels,
    extractByokModelsFromConfig,
} from './collect-byok-models';

/**
 * Every distinct BYOK model an organization could run: the BYOK `main` /
 * `fallback` models plus any per-repository / per-directory `byokModel`
 * overrides in the code-review config. This is the set the spend-limit
 * enablement gate must be able to price. Best-effort — a failed/absent lookup
 * just contributes nothing rather than failing the whole sweep.
 */
@Injectable()
export class GetOrgByokModelsUseCase {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string[]> {
        const byokConfig = await this.organizationParametersService
            .findByKey(
                OrganizationParametersKey.BYOK_CONFIG,
                organizationAndTeamData,
            )
            .then((p) => p?.configValue ?? null)
            .catch(() => null);

        const codeReviewConfig = await this.parametersService
            .findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            )
            .then((p) => p?.configValue ?? null)
            .catch(() => null);

        return collectByokModels(
            byokConfig,
            extractByokModelsFromConfig(codeReviewConfig),
        );
    }
}
