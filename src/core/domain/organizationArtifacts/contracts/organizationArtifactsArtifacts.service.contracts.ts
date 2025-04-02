import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IOrganizationArtifactsRepository } from './organizationArtifactsArtifacts.repository';
import { OrganizationArtifactsEntity } from '../entities/organizationArtifacts.entity';
import { ArtifactsToolType } from '@/shared/domain/enums/artifacts-tool-type.enum';

export const ORGANIZATION_ARTIFACTS_SERVICE_TOKEN = Symbol(
    'OrganizationArtifactsService',
);

export interface IOrganizationArtifactsService
    extends IOrganizationArtifactsRepository {
    executeWeekly(
        organizationAndTeamData: OrganizationAndTeamData,
        artifactsToolType?: ArtifactsToolType,
    );
    executeDaily(organizationAndTeamData: OrganizationAndTeamData);
    getRecentOrganizationArtifactsWithPrevious(
        organizationAndTeamData: OrganizationAndTeamData,
        weeksLimit: number,
        frequenceType?: string,
    ): Promise<{
        mostRecentArtifacts: {
            date: string;
            artifacts: Partial<OrganizationArtifactsEntity>[];
        };
        previousArtifacts: {
            date: string;
            artifacts: Partial<OrganizationArtifactsEntity>[];
        }[];
    }>;
}
