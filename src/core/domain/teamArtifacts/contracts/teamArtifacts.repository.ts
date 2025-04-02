import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { TeamArtifactsEntity } from '../entities/teamArtifacts.entity';
import { ITeamArtifacts } from '../interfaces/teamArtifacts.interface';

export const TEAM_ARTIFACTS_REPOSITORY_TOKEN = Symbol(
    'TeamArtifactsRepository',
);

export interface ITeamArtifactsRepository {
    create(
        teamArtifacts: Omit<ITeamArtifacts, 'uuid'>,
    ): Promise<TeamArtifactsEntity>;
    update(
        filter: Partial<ITeamArtifacts>,
        data: Partial<ITeamArtifacts>,
    ): Promise<TeamArtifactsEntity | undefined>;
    bulkUpdateOfEnrichedArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        updatedData: {
            uuid: string;
            relatedData: any;
        }[],
    ): Promise<void>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<TeamArtifactsEntity | null>;
    find(filter?: Partial<ITeamArtifacts>): Promise<TeamArtifactsEntity[]>;
    getNativeCollection(): any;
    findOne(
        filter?: Partial<ITeamArtifacts>,
    ): Promise<TeamArtifactsEntity | null>;
    getMostRecentArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        frequenceType?: string,
        resultType?: string,
    ): Promise<TeamArtifactsEntity[]>;
    getTeamArtifactsByWeeksLimit(
        organizationAndTeamData: OrganizationAndTeamData,
        weeksLimit: number,
        frequenceType?: string,
        resultType?: string,
    ): Promise<TeamArtifactsEntity[]>;
    dismissArtifact(
        artifactId: string,
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void>;
    getMostRecentArtifactVisible(
        organizationAndTeamData: OrganizationAndTeamData,
        frequenceType?: string,
        userId?: string,
    ): Promise<TeamArtifactsEntity[]>;
}
