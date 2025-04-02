import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IOrganizationArtifacts } from '../interfaces/organizationArtifacts.interface';
import { OrganizationArtifactsEntity } from '../entities/organizationArtifacts.entity';

export const ORGANIZATION_ARTIFACTS_REPOSITORY_TOKEN = Symbol(
    'OrganizationArtifactsRepository',
);

export interface IOrganizationArtifactsRepository {
    create(
        organizationArtifacts: Omit<IOrganizationArtifacts, 'uuid'>,
    ): Promise<OrganizationArtifactsEntity>;
    update(
        filter: Partial<IOrganizationArtifacts>,
        data: Partial<IOrganizationArtifacts>,
    ): Promise<OrganizationArtifactsEntity | undefined>;
    delete(uuid: string): Promise<void>;
    find(
        filter?: Partial<IOrganizationArtifacts>,
    ): Promise<OrganizationArtifactsEntity[]>;
    getNativeCollection(): any;
    findOne(
        filter?: Partial<IOrganizationArtifacts>,
    ): Promise<OrganizationArtifactsEntity | null>;
    getMostRecentArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        frequenceType?: string,
    ): Promise<OrganizationArtifactsEntity[]>;
    getOrganizationArtifactsByWeeksLimit(
        organizationAndTeamData: OrganizationAndTeamData,
        weeksLimit: number,
        frequenceType?: string,
    ): Promise<OrganizationArtifactsEntity[]>;
    getVisibleArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        userId?: string,
    ): Promise<OrganizationArtifactsEntity[]>;
    dismissArtifact(
        artifactId: string,
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void>;
}
