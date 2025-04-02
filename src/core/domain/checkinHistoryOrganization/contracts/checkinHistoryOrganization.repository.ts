import { CheckinHistoryOrganizationEntity } from "../entities/checkinHistoryOrganization.entity";
import { ICheckinHistoryOrganization } from "../interfaces/checkinHistoryOrganization.interface";

export const CHECKIN_HISTORY_ORGANIZATION_REPOSITORY_TOKEN = Symbol(
    'CheckinHistoryOrganizationRepository',
);

export interface ICheckinHistoryOrganizationRepository {
    create(
        organizationArtifacts: Omit<ICheckinHistoryOrganization, 'uuid'>,
    ): Promise<CheckinHistoryOrganizationEntity>;
    update(
        filter: Partial<ICheckinHistoryOrganization>,
        data: Partial<ICheckinHistoryOrganization>,
    ): Promise<CheckinHistoryOrganizationEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<CheckinHistoryOrganizationEntity | null>;
    find(filter?: Partial<ICheckinHistoryOrganization>): Promise<CheckinHistoryOrganizationEntity[]>;
    getNativeCollection(): any;
    findOne(
        filter?: Partial<ICheckinHistoryOrganization>,
    ): Promise<CheckinHistoryOrganizationEntity | null>;
    getLastCheckinForTeam(teamId): Promise<CheckinHistoryOrganizationEntity>;
    getCheckinHistoryWithDayLimit(
        filter: any,
        limit?: number,
    ): Promise<CheckinHistoryOrganizationEntity[]>;
}
