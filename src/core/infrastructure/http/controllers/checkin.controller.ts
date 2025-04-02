import { Controller, Query, Get, Body, Post } from '@nestjs/common';
import { GetSectionsInfoUseCase } from '@/core/application/use-cases/checkin/get-sections-info.use-case';
import { CheckinConfigValue } from '@/core/domain/parameters/types/configValue.type';
import { SaveCheckinConfigUseCase } from '@/core/application/use-cases/checkin/save-checkin-config.use-case';
import { GetCheckinConfigUseCase } from '@/core/application/use-cases/checkin/get-checkin-config.use-case';

@Controller('checkin')
export class CheckinController {
    constructor(
        private readonly getSectionsInfoUseCase: GetSectionsInfoUseCase,
        private readonly saveCheckinConfigUseCase: SaveCheckinConfigUseCase,
        private readonly getCheckinConfigUseCase: GetCheckinConfigUseCase,
    ) {}

    @Post('/save-configs')
    public async generateCheckinConfig(
        @Body()
        body: {
            checkinConfig: CheckinConfigValue;
            organizationAndTeamData: {
                teamId: string;
            };
        },
    ) {
        return this.saveCheckinConfigUseCase.execute(
            body.organizationAndTeamData,
            body.checkinConfig,
        );
    }

    @Get('/get-configs')
    public async getConfig(
        @Query('checkinId') checkinId: string,
        @Query('teamId') teamId: string,
    ) {
        return this.getCheckinConfigUseCase.execute({ teamId }, checkinId);
    }

    @Get('/sections-info')
    public async getSectionsInfo() {
        return this.getSectionsInfoUseCase.execute();
    }
}
