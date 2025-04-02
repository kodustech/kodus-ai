import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IParametersService } from '@/core/domain/parameters/contracts/parameters.service.contract';
import { PARAMETERS_SERVICE_TOKEN } from '@/core/domain/parameters/contracts/parameters.service.contract';
import { artifacts } from '@/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json';
import { Inject, Injectable } from '@nestjs/common';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';

@Injectable()
export class SaveArtifactsStructureUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
    ) {}

    async execute(organizationAndTeamData: OrganizationAndTeamData) {
        await this.saveTeamArtifactsStructure(organizationAndTeamData);
    }

    async saveTeamArtifactsStructure(organizationAndTeamData) {
        try {
            const teamArtifacts = artifacts.map((artifact) => {
                let status = artifact.teamMethodology.includes('all');

                return {
                    name: artifact.name,
                    status: status,
                };
            });

            return await this.parametersService.createOrUpdateConfig(
                ParametersKey.TEAM_ARTIFACTS_CONFIG,
                teamArtifacts,
                organizationAndTeamData,
            );
        } catch (error) {
            console.log('Error saving artifacts structure: ', error);
        }
    }
}
