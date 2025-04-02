import { GetStoryUrlUseCase } from '@/core/application/use-cases/msteams/get-story-url.use-case';
import { Controller, Get } from '@nestjs/common';

@Controller('msteams')
export class MsTeamsController {
    constructor(readonly getStoryUrlUseCase: GetStoryUrlUseCase) {}

    @Get('/story-url')
    public async getTeamsStoryUrl() {
        return this.getStoryUrlUseCase.execute();
    }
}
