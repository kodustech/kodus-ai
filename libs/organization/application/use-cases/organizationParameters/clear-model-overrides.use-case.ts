import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import {
    clearModelOverrides,
    type ClearOverrideTarget,
} from './model-overrides.util';

/**
 * Bulk-clear per-scope `byokModel` overrides (set to '' = inherit) at the given
 * targets, then persist the whole code-review config. Only the `byokModel`
 * field is touched. Used by the provider-change banner's "clear overrides"
 * action. A target with no `repositoryId` clears the global override.
 */
@Injectable()
export class ClearModelOverridesUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        targets: ClearOverrideTarget[],
    ): Promise<{ clearedCount: number }> {
        if (!Array.isArray(targets) || targets.length === 0) {
            throw new BadRequestException('No override targets provided');
        }

        const parameter = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );
        if (!parameter?.configValue) {
            return { clearedCount: 0 };
        }

        const { configValue, clearedCount } = clearModelOverrides(
            parameter.configValue,
            targets,
        );

        if (clearedCount > 0) {
            await this.parametersService.createOrUpdateConfig(
                ParametersKey.CODE_REVIEW_CONFIG,
                configValue as any,
                organizationAndTeamData,
            );
        }

        return { clearedCount };
    }
}
