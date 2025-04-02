import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { TeamArtifactsEntity } from '../entities/teamArtifacts.entity';
import { ITeamArtifactsRepository } from './teamArtifacts.repository';
import { ArtifactsToolType } from '@/shared/domain/enums/artifacts-tool-type.enum';

export const TEAM_ARTIFACTS_SERVICE_TOKEN = Symbol('TeamArtifactsService');

export interface ITeamArtifactsService extends ITeamArtifactsRepository {
    executeWeekly(
        organizationAndTeamData: OrganizationAndTeamData,
        artifactsToolType?: ArtifactsToolType,
    );
    executeDaily(organizationAndTeamData: OrganizationAndTeamData);
    getRecentTeamArtifactsWithPrevious(
        organizationAndTeamData: OrganizationAndTeamData,
        weeksLimit: number,
        frequenceType?: string,
        resultType?: string,
        onlyCurrentDayAsRecent?: boolean,
    ): Promise<{
        mostRecentArtifacts: {
            date: string;
            artifacts: Partial<TeamArtifactsEntity>[];
        };
        previousArtifacts: {
            date: string;
            artifacts: Partial<TeamArtifactsEntity>[];
        }[];
    }>;
    executeForSprint(
        organizationAndTeamData: OrganizationAndTeamData,
        period: {
            startDate: string;
            endDate: string;
        },
    );
    bulkUpdateOfEnrichedArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        updatedData: {
            uuid: string;
            relatedData: any;
        }[],
    ): Promise<void>;
}
