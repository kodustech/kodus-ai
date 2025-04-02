'@/core/domain/checkinHistoryOrganization/contracts/checkinHistory.service.contracts';
import { ICheckinHistoryOrganizationService } from '@/core/domain/checkinHistoryOrganization/contracts/checkinHistory.service.contracts';
import { CHECKIN_HISTORY_ORGANIZATION_REPOSITORY_TOKEN, ICheckinHistoryOrganizationRepository } from '@/core/domain/checkinHistoryOrganization/contracts/checkinHistoryOrganization.repository';
import { CheckinHistoryOrganizationEntity } from '@/core/domain/checkinHistoryOrganization/entities/checkinHistoryOrganization.entity';
import { ICheckinHistoryOrganization } from '@/core/domain/checkinHistoryOrganization/interfaces/checkinHistoryOrganization.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class CheckinHistoryOrganizationService implements ICheckinHistoryOrganizationService {
    constructor(
        @Inject(CHECKIN_HISTORY_ORGANIZATION_REPOSITORY_TOKEN)
        private readonly checkinHistoryOrganizationRepository: ICheckinHistoryOrganizationRepository,
    ) { }
    create(
        checkinHistory: Omit<ICheckinHistoryOrganization, 'uuid'>,
    ): Promise<CheckinHistoryOrganizationEntity> {
        return this.checkinHistoryOrganizationRepository.create(checkinHistory);
    }

    update(
        filter: Partial<ICheckinHistoryOrganization>,
        data: Partial<ICheckinHistoryOrganization>,
    ): Promise<CheckinHistoryOrganizationEntity> {
        return this.checkinHistoryOrganizationRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.checkinHistoryOrganizationRepository.delete(uuid);
    }

    findById(uuid: string): Promise<CheckinHistoryOrganizationEntity> {
        return this.checkinHistoryOrganizationRepository.findById(uuid);
    }

    find(filter?: Partial<ICheckinHistoryOrganization>): Promise<CheckinHistoryOrganizationEntity[]> {
        return this.checkinHistoryOrganizationRepository.find(filter);
    }

    getNativeCollection() {
        return this.checkinHistoryOrganizationRepository.getNativeCollection();
    }

    findOne(filter?: Partial<ICheckinHistoryOrganization>): Promise<CheckinHistoryOrganizationEntity> {
        return this.checkinHistoryOrganizationRepository.findOne(filter);
    }

    getLastCheckinForTeam(teamId: string) {
        return this.checkinHistoryOrganizationRepository.getLastCheckinForTeam(teamId);
    }

    async getCheckinHistoryWithDayLimit(
        filter: Partial<ICheckinHistoryOrganization>,
        limit?: number,
    ): Promise<CheckinHistoryOrganizationEntity[]> {
        // try {
        //     return await this.checkinHistoryOrganizationRepository.getCheckinHistoryWithDayLimit(
        //         {
        //             teamId: filter.teamId,
        //             organizationId: filter.organizationId,
        //             type: filter.type,
        //         },
        //         limit,
        //     );
        // } catch (error) {
        //     throw new Error('Error ao buscar histórico de checkin', error);
        // }
        throw new Error("Not implemented")
    }

    register(
        checkinHistory: Omit<ICheckinHistoryOrganization, 'uuid'>,
    ): Promise<CheckinHistoryOrganizationEntity> {
        return this.create({ ...checkinHistory });
    }
}
