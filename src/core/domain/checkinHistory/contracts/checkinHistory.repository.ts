import { CheckinHistoryEntity } from '../entities/checkinHistory.entity';
import { ICheckinHistory } from '../interfaces/checkinHistory.interface';

export const CHECKIN_HISTORY_REPOSITORY_TOKEN = Symbol(
    'CheckinHistoryRepository',
);

export interface ICheckinHistoryRepository {
    create(
        teamArtifacts: Omit<ICheckinHistory, 'uuid'>,
    ): Promise<CheckinHistoryEntity>;
    update(
        filter: Partial<ICheckinHistory>,
        data: Partial<ICheckinHistory>,
    ): Promise<CheckinHistoryEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<CheckinHistoryEntity | null>;
    find(filter?: Partial<ICheckinHistory>): Promise<CheckinHistoryEntity[]>;
    getNativeCollection(): any;
    findOne(
        filter?: Partial<ICheckinHistory>,
    ): Promise<CheckinHistoryEntity | null>;
    getLastCheckinForTeam(teamId): Promise<CheckinHistoryEntity>;
    getCheckinHistoryWithDayLimit(
        filter: any,
        limit?: number,
    ): Promise<CheckinHistoryEntity[]>;
    getCheckinHistoryByDays(
        filter: Partial<ICheckinHistory>,
        days: number,
    ): Promise<CheckinHistoryEntity[]>;
}
