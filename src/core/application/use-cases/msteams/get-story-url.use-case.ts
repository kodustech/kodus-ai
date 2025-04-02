import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import {
    IMSTeamsService,
    MSTEAMS_SERVICE_TOKEN,
} from '@/core/domain/msTeams/msTeams.service.contract';
import { Inject } from '@nestjs/common';

export class GetStoryUrlUseCase implements IUseCase {
    constructor(
        @Inject(MSTEAMS_SERVICE_TOKEN)
        private readonly msTeamsService: IMSTeamsService,
    ) {}
    public async execute() {
        return this.msTeamsService.getTeamsStoryUrl();
    }
}
