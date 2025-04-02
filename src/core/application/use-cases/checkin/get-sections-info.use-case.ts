import { Inject, Injectable } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { CheckinService } from '@/core/infrastructure/adapters/services/checkin/checkin.service';
import {
    CHECKIN_SERVICE_TOKEN,
    ICheckinService,
} from '@/core/domain/checkins/contracts/checkin.service.contract';

@Injectable()
export class GetSectionsInfoUseCase implements IUseCase {
    constructor(
        @Inject(CHECKIN_SERVICE_TOKEN)
        private readonly checkinService: ICheckinService,
    ) {}

    async execute(): Promise<{ name: string; id: string }[]> {
        return await this.checkinService.getSectionsInfo();
    }
}
