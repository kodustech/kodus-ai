import {
    CHECKIN_HISTORY_REPOSITORY_TOKEN,
    ICheckinHistoryRepository,
} from '@/core/domain/checkinHistory/contracts/checkinHistory.repository';
import { ICheckinHistoryService } from '@/core/domain/checkinHistory/contracts/checkinHistory.service.contracts';
import { CheckinHistoryEntity } from '@/core/domain/checkinHistory/entities/checkinHistory.entity';
import { ICheckinHistory } from '@/core/domain/checkinHistory/interfaces/checkinHistory.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class CheckinHistoryService implements ICheckinHistoryService {
    constructor(
        @Inject(CHECKIN_HISTORY_REPOSITORY_TOKEN)
        private readonly checkinHistoryRepository: ICheckinHistoryRepository,
    ) {}
    create(
        checkinHistory: Omit<ICheckinHistory, 'uuid'>,
    ): Promise<CheckinHistoryEntity> {
        return this.checkinHistoryRepository.create(checkinHistory);
    }

    update(
        filter: Partial<ICheckinHistory>,
        data: Partial<ICheckinHistory>,
    ): Promise<CheckinHistoryEntity> {
        return this.checkinHistoryRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.checkinHistoryRepository.delete(uuid);
    }

    findById(uuid: string): Promise<CheckinHistoryEntity> {
        return this.checkinHistoryRepository.findById(uuid);
    }

    find(filter?: Partial<ICheckinHistory>): Promise<CheckinHistoryEntity[]> {
        return this.checkinHistoryRepository.find(filter);
    }

    getNativeCollection() {
        return this.checkinHistoryRepository.getNativeCollection();
    }

    findOne(filter?: Partial<ICheckinHistory>): Promise<CheckinHistoryEntity> {
        return this.checkinHistoryRepository.findOne(filter);
    }

    getLastCheckinForTeam(teamId: string) {
        return this.checkinHistoryRepository.getLastCheckinForTeam(teamId);
    }

    async getCheckinHistoryWithDayLimit(
        filter: Partial<ICheckinHistory>,
        limit?: number,
    ): Promise<CheckinHistoryEntity[]> {
        try {
            return await this.checkinHistoryRepository.getCheckinHistoryWithDayLimit(
                {
                    teamId: filter.teamId,
                    organizationId: filter.organizationId,
                    type: filter.type,
                },
                limit,
            );
        } catch (error) {
            throw new Error('Error fetching check-in history', {
                cause: error,
            });
        }
    }

    async getCheckinHistoryByDays(
        filter: Partial<ICheckinHistory>,
        days: number,
    ): Promise<CheckinHistoryEntity[]> {
        return this.checkinHistoryRepository.getCheckinHistoryByDays(
            filter,
            days,
        );
    }

    register(
        checkinHistory: Omit<ICheckinHistory, 'uuid'>,
    ): Promise<CheckinHistoryEntity> {
        return this.create({ ...checkinHistory });
    }
}
